import * as cdp from "./cdp.js";
import { RING_LIMITS } from "./wire.js";

export interface ConsoleEntry {
  ts: number;
  level: string;
  text: string;
  source?: string;
  url?: string;
  line?: number;
  stack?: any;
}

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  startedAt: number;
  endedAt?: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  fromCache?: boolean;
  fromServiceWorker?: boolean;
  failed?: boolean;
  errorText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  encodedDataLength?: number;
  type?: string;
}

interface TabState {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  inflight: number;
  // ms timestamp of the most recent Network.* event. waitForStable uses a sliding-window
  // "no network activity for N ms" check rather than "inflight==0", so persistent long-poll
  // / SSE / websocket connections on the page do not block stabilization.
  lastNetworkAt: number;
  lastIdleResolvers: Array<() => void>;
  idleTimer?: any;
}

const tabs = new Map<number, TabState>();

function ensureTab(tabId: number): TabState {
  let s = tabs.get(tabId);
  if (!s) {
    s = {
      console: [],
      network: [],
      inflight: 0,
      lastNetworkAt: 0,
      lastIdleResolvers: [],
    };
    tabs.set(tabId, s);
  }
  return s;
}

function push<T>(arr: T[], item: T, limit: number) {
  arr.push(item);
  if (arr.length > limit) arr.splice(0, arr.length - limit);
}

let listenerInstalled = false;

function installGlobalListener() {
  if (listenerInstalled) return;
  listenerInstalled = true;
  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    const tabId = source.tabId;
    if (typeof tabId !== "number") return;
    const s = tabs.get(tabId);
    if (!s) return;
    handleCdpEvent(s, tabId, method, params);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId === "number") tabs.delete(source.tabId);
  });
  chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));
}

function handleCdpEvent(s: TabState, _tabId: number, method: string, p: any) {
  if (method.startsWith("Network.")) s.lastNetworkAt = Date.now();
  switch (method) {
    case "Runtime.consoleAPICalled": {
      push(
        s.console,
        {
          ts: Date.now(),
          level: p.type,
          text: (p.args ?? [])
            .map((a: any) => (a.value !== undefined ? String(a.value) : a.description ?? ""))
            .join(" "),
          source: "console-api",
          url: p.stackTrace?.callFrames?.[0]?.url,
          line: p.stackTrace?.callFrames?.[0]?.lineNumber,
          stack: p.stackTrace,
        },
        RING_LIMITS.console
      );
      break;
    }
    case "Log.entryAdded": {
      const e = p.entry;
      push(
        s.console,
        {
          ts: e.timestamp ?? Date.now(),
          level: e.level,
          text: e.text,
          source: e.source,
          url: e.url,
          line: e.lineNumber,
          stack: e.stackTrace,
        },
        RING_LIMITS.console
      );
      break;
    }
    case "Runtime.exceptionThrown": {
      const d = p.exceptionDetails;
      push(
        s.console,
        {
          ts: Date.now(),
          level: "error",
          text: d.text + (d.exception ? `: ${d.exception.description ?? ""}` : ""),
          source: "exception",
          url: d.url,
          line: d.lineNumber,
          stack: d.stackTrace,
        },
        RING_LIMITS.console
      );
      break;
    }
    case "Network.requestWillBeSent": {
      bumpInflight(s, +1);
      const r: NetworkEntry = {
        requestId: p.requestId,
        url: p.request.url,
        method: p.request.method,
        startedAt: Date.now(),
        requestHeaders: p.request.headers,
        type: p.type,
      };
      push(s.network, r, RING_LIMITS.network);
      break;
    }
    case "Network.responseReceived": {
      const r = s.network.find((x) => x.requestId === p.requestId);
      if (r) {
        r.status = p.response.status;
        r.statusText = p.response.statusText;
        r.mimeType = p.response.mimeType;
        r.responseHeaders = p.response.headers;
        r.fromCache = p.response.fromDiskCache;
        r.fromServiceWorker = p.response.fromServiceWorker;
      }
      break;
    }
    case "Network.loadingFinished": {
      const r = s.network.find((x) => x.requestId === p.requestId);
      if (r) {
        r.endedAt = Date.now();
        r.encodedDataLength = p.encodedDataLength;
      }
      bumpInflight(s, -1);
      break;
    }
    case "Network.loadingFailed": {
      const r = s.network.find((x) => x.requestId === p.requestId);
      if (r) {
        r.endedAt = Date.now();
        r.failed = true;
        r.errorText = p.errorText;
      }
      bumpInflight(s, -1);
      break;
    }
  }
}

function bumpInflight(s: TabState, delta: number) {
  s.inflight = Math.max(0, s.inflight + delta);
  scheduleIdle(s);
}

const IDLE_QUIET_MS = 500;

// "Idle" means no Network.* events for IDLE_QUIET_MS, regardless of inflight count.
// This makes waitForStable robust to long-lived SSE / websocket / long-poll connections
// that are a normal part of modern apps (Gmail, Calendar, X, etc.) — their persistent
// requests never call loadingFinished, so the old inflight==0 check would never fire.
function scheduleIdle(s: TabState) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (Date.now() - s.lastNetworkAt >= IDLE_QUIET_MS) {
      const list = s.lastIdleResolvers.splice(0);
      for (const r of list) r();
    } else {
      // A late event landed — reschedule.
      scheduleIdle(s);
    }
  }, IDLE_QUIET_MS);
}

export async function ensureAttached(tabId: number): Promise<TabState> {
  installGlobalListener();
  const s = ensureTab(tabId);
  await cdp.attach(tabId);
  // Enable domains we care about. These are idempotent at CDP level.
  await Promise.all([
    cdp.send(tabId, "Runtime.enable"),
    cdp.send(tabId, "Log.enable").catch(() => undefined),
    cdp.send(tabId, "Network.enable"),
    cdp.send(tabId, "Page.enable"),
    cdp.send(tabId, "DOM.enable"),
    cdp.send(tabId, "Accessibility.enable").catch(() => undefined),
  ]);
  return s;
}

export function getState(tabId: number): TabState | undefined {
  return tabs.get(tabId);
}

export function waitForIdle(tabId: number, timeoutMs: number): Promise<"idle" | "timeout"> {
  const s = ensureTab(tabId);
  return new Promise((resolve) => {
    // If the network has already been quiet for IDLE_QUIET_MS, resolve immediately.
    if (s.lastNetworkAt === 0 || Date.now() - s.lastNetworkAt >= IDLE_QUIET_MS) {
      resolve("idle");
      return;
    }
    scheduleIdle(s);
    const onIdle = () => {
      clearTimeout(t);
      resolve("idle");
    };
    s.lastIdleResolvers.push(onIdle);
    const t = setTimeout(() => {
      const idx = s.lastIdleResolvers.indexOf(onIdle);
      if (idx >= 0) s.lastIdleResolvers.splice(idx, 1);
      resolve("timeout");
    }, timeoutMs);
  });
}
