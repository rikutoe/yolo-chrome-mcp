import * as cdp from "./cdp.js";
import { ensureAttached, getState, waitForIdle } from "./session.js";
import { DEFAULTS } from "./wire.js";
import { classifyAction, type SafetyDecision } from "./safety.js";
import { promptInTab } from "./overlayBridge.js";

let safetyMode: "always" | "dangerous-only" | "off" = "dangerous-only";

// --- Stage 1 ---

export async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    windowId: t.windowId,
    incognito: t.incognito,
    status: t.status,
  }));
}

export async function getTabInfo({ tabId }: { tabId: number }) {
  const t = await chrome.tabs.get(tabId);
  await ensureAttached(tabId);
  const frameTree: any = await cdp.send(tabId, "Page.getFrameTree").catch(() => null);
  return {
    id: t.id,
    title: t.title,
    url: t.url,
    favIconUrl: t.favIconUrl,
    active: t.active,
    audible: t.audible,
    discarded: t.discarded,
    pinned: t.pinned,
    windowId: t.windowId,
    frames: frameTree?.frameTree
      ? flattenFrames(frameTree.frameTree)
      : [],
  };
}

function flattenFrames(f: any): any[] {
  const out: any[] = [{ id: f.frame.id, url: f.frame.url, name: f.frame.name }];
  for (const c of f.childFrames ?? []) out.push(...flattenFrames(c));
  return out;
}

// --- Stage 2 ---

export async function screenshot({
  tabId,
  fullPage,
  format,
  quality,
}: {
  tabId: number;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
}) {
  await ensureAttached(tabId);
  const params: any = { format: format ?? "jpeg" };
  if (params.format === "jpeg") params.quality = quality ?? 80;
  if (fullPage) {
    // Capture beyond viewport.
    const metrics: any = await cdp.send(tabId, "Page.getLayoutMetrics");
    params.captureBeyondViewport = true;
    params.clip = {
      x: 0,
      y: 0,
      width: metrics.cssContentSize?.width ?? metrics.contentSize.width,
      height: metrics.cssContentSize?.height ?? metrics.contentSize.height,
      scale: 1,
    };
  }
  const res: any = await cdp.send(tabId, "Page.captureScreenshot", params);
  return {
    dataBase64: res.data,
    mimeType: params.format === "png" ? "image/png" : "image/jpeg",
  };
}

export async function getPageText({
  tabId,
  offset,
  maxChars,
}: {
  tabId: number;
  offset?: number;
  maxChars?: number;
}) {
  await ensureAttached(tabId);
  const expr = `(() => {
    const w = document.body ? document.body.innerText : '';
    return w;
  })()`;
  const res: any = await cdp.send(tabId, "Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  });
  const full: string = res.result?.value ?? "";
  const off = offset ?? 0;
  const max = maxChars ?? DEFAULTS.pageTextChars;
  const slice = full.slice(off, off + max);
  return {
    text: slice,
    offset: off,
    returnedChars: slice.length,
    totalChars: full.length,
    truncated: off + slice.length < full.length,
  };
}

// --- Stage 3 ---

interface InteractableNode {
  stableId: string;
  role: string;
  label: string;
  value?: string;
  tag?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
  href?: string;
}

const nodeMaps = new Map<number, Map<string, { backendNodeId: number; objectId?: string }>>();

export async function getInteractables({
  tabId,
  viewport,
  limit,
}: {
  tabId: number;
  viewport?: "visible" | "all";
  limit?: number;
}) {
  await ensureAttached(tabId);
  const ax: any = await cdp.send(tabId, "Accessibility.getFullAXTree");
  const nodes: any[] = ax.nodes ?? [];

  const interactiveRoles = new Set([
    "button",
    "link",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "menuitem",
    "tab",
    "switch",
    "slider",
    "spinbutton",
    "option",
  ]);

  // Map AXNode -> backendNodeId.
  const layoutVp: any = await cdp.send(tabId, "Page.getLayoutMetrics");
  const vw = layoutVp.cssVisualViewport ?? layoutVp.visualViewport;
  const viewportRect = {
    x: vw.pageX ?? 0,
    y: vw.pageY ?? 0,
    w: vw.clientWidth ?? 1280,
    h: vw.clientHeight ?? 720,
  };

  const out: InteractableNode[] = [];
  const map = new Map<string, { backendNodeId: number; objectId?: string }>();

  for (const n of nodes) {
    const role = n.role?.value;
    if (!role || !interactiveRoles.has(role)) continue;
    if (n.ignored) continue;
    const backendNodeId: number | undefined = n.backendDOMNodeId;
    if (!backendNodeId) continue;
    const label =
      n.name?.value ??
      n.description?.value ??
      (n.properties ?? [])
        .filter((p: any) => p.name === "value")
        .map((p: any) => String(p.value?.value ?? ""))
        .join(" ");
    const stableId = `n${backendNodeId}`;
    let bounds:
      | { x: number; y: number; width: number; height: number }
      | undefined;
    try {
      const box: any = await cdp.send(tabId, "DOM.getBoxModel", { backendNodeId });
      const [x1, y1, x2, , , y3] = box.model.border as number[];
      bounds = {
        x: Math.round(x1),
        y: Math.round(y1),
        width: Math.round(x2 - x1),
        height: Math.round(y3 - y1),
      };
    } catch {
      // Non-rendered (display:none, etc.) — skip when only visible requested.
    }
    const inViewport = !!(
      bounds &&
      bounds.x + bounds.width > viewportRect.x &&
      bounds.x < viewportRect.x + viewportRect.w &&
      bounds.y + bounds.height > viewportRect.y &&
      bounds.y < viewportRect.y + viewportRect.h
    );
    if ((viewport ?? "visible") === "visible" && (!bounds || !inViewport)) continue;
    map.set(stableId, { backendNodeId });
    out.push({
      stableId,
      role,
      label: (label ?? "").slice(0, 200),
      tag: undefined,
      bounds,
      inViewport,
    });
    if (out.length >= (limit ?? 100)) break;
  }
  nodeMaps.set(tabId, map);
  return { nodes: out, viewport: viewportRect };
}

function getNode(tabId: number, stableId: string) {
  const m = nodeMaps.get(tabId);
  const n = m?.get(stableId);
  if (!n) {
    throw new Error(
      `Unknown stableId '${stableId}'. Call getInteractables on tab ${tabId} first to refresh the node map.`
    );
  }
  return n;
}

// --- Stage 4 ---

export async function getConsoleLogs({
  tabId,
  level,
  since,
  limit,
}: {
  tabId: number;
  level?: string;
  since?: number;
  limit?: number;
}) {
  await ensureAttached(tabId);
  const s = getState(tabId)!;
  let entries = s.console;
  if (since) entries = entries.filter((e) => e.ts >= since);
  if (level && level !== "all") {
    entries = entries.filter((e) => e.level === level || (level === "error" && e.level === "error"));
  }
  const slice = entries.slice(-(limit ?? DEFAULTS.consoleRecent));
  return {
    total: s.console.length,
    returned: slice.length,
    entries: slice,
  };
}

export async function getNetworkActivity({
  tabId,
  failedOnly,
  since,
  limit,
}: {
  tabId: number;
  failedOnly?: boolean;
  since?: number;
  limit?: number;
}) {
  await ensureAttached(tabId);
  const s = getState(tabId)!;
  let entries = s.network.slice();
  if (since) entries = entries.filter((e) => e.startedAt >= since);
  const failedList = entries.filter((e) => e.failed || (e.status && e.status >= 400));
  const slow = [...entries]
    .filter((e) => e.endedAt && e.endedAt - e.startedAt > 1000)
    .sort((a, b) => b.endedAt! - b.startedAt - (a.endedAt! - a.startedAt))
    .slice(0, 5);
  const items = (failedOnly ?? true ? failedList : entries).slice(-(limit ?? DEFAULTS.networkRecent));
  return {
    total: s.network.length,
    failed: failedList.length,
    slowTop5: slow.map((e) => ({
      requestId: e.requestId,
      url: e.url,
      durationMs: e.endedAt! - e.startedAt,
    })),
    items: items.map(summarize),
  };
}

function summarize(e: any) {
  return {
    requestId: e.requestId,
    url: e.url,
    method: e.method,
    status: e.status,
    failed: e.failed,
    errorText: e.errorText,
    durationMs: e.endedAt ? e.endedAt - e.startedAt : undefined,
    sizeBytes: e.encodedDataLength,
    mimeType: e.mimeType,
    type: e.type,
  };
}

export async function getNetworkRequest({
  tabId,
  requestId,
}: {
  tabId: number;
  requestId: string;
}) {
  await ensureAttached(tabId);
  const s = getState(tabId)!;
  const e = s.network.find((x) => x.requestId === requestId);
  if (!e) throw new Error(`Unknown requestId '${requestId}' for tab ${tabId}`);
  let responseBody: { body?: string; base64Encoded?: boolean } | undefined;
  try {
    responseBody = await cdp.send(tabId, "Network.getResponseBody", { requestId });
  } catch (err: any) {
    responseBody = { body: `(unavailable: ${err.message})` };
  }
  return { ...e, responseBody };
}

export async function getStorage({
  tabId,
  types,
}: {
  tabId: number;
  types: ("cookie" | "localStorage" | "sessionStorage")[];
}) {
  const t = await chrome.tabs.get(tabId);
  const url = t.url ?? "";
  const out: any = {};
  if (types.includes("cookie")) {
    out.cookie = await chrome.cookies.getAll({ url });
  }
  if (types.includes("localStorage") || types.includes("sessionStorage")) {
    await ensureAttached(tabId);
    if (types.includes("localStorage")) {
      out.localStorage = await dumpStorage(tabId, "localStorage");
    }
    if (types.includes("sessionStorage")) {
      out.sessionStorage = await dumpStorage(tabId, "sessionStorage");
    }
  }
  return out;
}

async function dumpStorage(tabId: number, kind: "localStorage" | "sessionStorage") {
  const expr = `(() => {
    const o = {};
    const s = window.${kind};
    for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); }
    return o;
  })()`;
  const res: any = await cdp.send(tabId, "Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  });
  return res.result?.value ?? {};
}

// --- Stage 5 ---

export async function getSourceAt({
  tabId,
  url,
  line,
  range,
}: {
  tabId: number;
  url: string;
  line: number;
  range?: number;
}) {
  await ensureAttached(tabId);
  const resp = await fetch(url);
  const text = await resp.text();
  const lines = text.split("\n");
  const r = range ?? DEFAULTS.sourceContextLines;
  const from = Math.max(0, line - r);
  const to = Math.min(lines.length, line + r + 1);
  return {
    url,
    fromLine: from,
    toLine: to,
    snippet: lines.slice(from, to).join("\n"),
    sourcemapResolved: false,
  };
}

// --- Actions ---

export async function click({ tabId, stableId }: { tabId: number; stableId: string }) {
  const n = getNode(tabId, stableId);
  const decision = await maybeConfirm(tabId, "click", { stableId });
  if (decision === "denied") return { ok: false, reason: "user-denied" };
  await scrollIntoView(tabId, n.backendNodeId);
  const box: any = await cdp.send(tabId, "DOM.getBoxModel", { backendNodeId: n.backendNodeId });
  const [x1, y1, x2, , , y3] = box.model.border as number[];
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y3) / 2;
  await dispatchClick(tabId, cx, cy);
  return { ok: true, x: cx, y: cy };
}

export async function typeText({
  tabId,
  stableId,
  text,
  clearFirst,
  pressEnter,
}: {
  tabId: number;
  stableId: string;
  text: string;
  clearFirst?: boolean;
  pressEnter?: boolean;
}) {
  const n = getNode(tabId, stableId);
  const decision = await maybeConfirm(tabId, "type", { stableId, sample: text.slice(0, 40) });
  if (decision === "denied") return { ok: false, reason: "user-denied" };
  await cdp.send(tabId, "DOM.focus", { backendNodeId: n.backendNodeId });
  if (clearFirst ?? true) {
    await cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: 4 /* meta */,
      key: "a",
      code: "KeyA",
    });
    await cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: 4,
      key: "a",
      code: "KeyA",
    });
    await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete" });
    await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete" });
  }
  await cdp.send(tabId, "Input.insertText", { text });
  if (pressEnter) {
    await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
    await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  }
  return { ok: true };
}

export async function scroll({
  tabId,
  to,
  by,
}: {
  tabId: number;
  to?: { x: number; y: number };
  by?: { x: number; y: number };
}) {
  await ensureAttached(tabId);
  let expr: string;
  if (to) {
    expr = `window.scrollTo(${to.x}, ${to.y})`;
  } else if (by) {
    expr = `window.scrollBy(${by.x}, ${by.y})`;
  } else {
    throw new Error("scroll requires 'to' or 'by'");
  }
  await cdp.send(tabId, "Runtime.evaluate", { expression: expr });
  return { ok: true };
}

export async function navigate({ tabId, url }: { tabId: number; url: string }) {
  const decision = await maybeConfirm(tabId, "navigate", { url });
  if (decision === "denied") return { ok: false, reason: "user-denied" };
  await chrome.tabs.update(tabId, { url });
  return { ok: true };
}

export async function createTab({
  url,
  active,
  windowId,
}: {
  url: string;
  active?: boolean;
  windowId?: number;
}) {
  const t = await chrome.tabs.create({
    url,
    active: active ?? true,
    ...(windowId !== undefined ? { windowId } : {}),
  });
  return {
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    windowId: t.windowId,
    incognito: t.incognito,
    status: t.status,
  };
}

export async function closeTab({ tabIds }: { tabIds: number | number[] }) {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  await chrome.tabs.remove(ids);
  return { closed: ids };
}

export async function evalJs({
  tabId,
  expression,
  awaitPromise,
}: {
  tabId: number;
  expression: string;
  awaitPromise?: boolean;
}) {
  await ensureAttached(tabId);
  const decision = await maybeConfirm(tabId, "evalJs", { expression: expression.slice(0, 120) });
  if (decision === "denied") return { ok: false, reason: "user-denied" };
  const res: any = await cdp.send(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: awaitPromise ?? true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    return {
      ok: false,
      exception: res.exceptionDetails.text + (res.exceptionDetails.exception?.description ?? ""),
    };
  }
  return { ok: true, value: res.result?.value };
}

export async function waitForStable({
  tabId,
  timeout,
}: {
  tabId: number;
  timeout?: number;
}) {
  await ensureAttached(tabId);
  const status = await waitForIdle(tabId, timeout ?? DEFAULTS.waitStableMs);
  return { status };
}

export async function setSafetyMode({
  mode,
}: {
  mode: "always" | "dangerous-only" | "off";
}) {
  safetyMode = mode;
  await chrome.storage.local.set({ safetyMode: mode });
  return { mode };
}

export async function loadSafetyMode() {
  const v = await chrome.storage.local.get("safetyMode");
  if (v.safetyMode) safetyMode = v.safetyMode;
}

// --- Helpers ---

async function scrollIntoView(tabId: number, backendNodeId: number) {
  try {
    await cdp.send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // Some Chrome builds don't expose this — fall back to focus.
    try {
      await cdp.send(tabId, "DOM.focus", { backendNodeId });
    } catch {}
  }
}

async function dispatchClick(tabId: number, x: number, y: number) {
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await cdp.send(tabId, "Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      clickCount: 1,
      buttons: 1,
    });
  }
}

async function maybeConfirm(
  tabId: number,
  action: string,
  details: any
): Promise<SafetyDecision> {
  if (safetyMode === "off") return "allowed";
  let isDangerous = true;
  if (safetyMode === "dangerous-only") {
    isDangerous = await classifyAction(tabId, action, details);
    if (!isDangerous) return "allowed";
  }
  const ok = await promptInTab(tabId, action, details);
  return ok ? "allowed" : "denied";
}
