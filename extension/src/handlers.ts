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
  // AX-tree state flags. Only included when truthy / set, to keep the wire payload
  // small for the 99% case (vanilla buttons/links with no special state). When absent
  // the property is undefined — read it as "default / no signal" rather than "false".
  disabled?: boolean;
  checked?: boolean | "mixed";
  expanded?: boolean;
  pressed?: boolean;
  selected?: boolean;
  required?: boolean;
  readonly?: boolean;
  focused?: boolean;
}

// Extract AX state flags from a node's `properties` array.
// AX `properties` is an array of { name, value: { type, value } } objects.
function extractStateFlags(axNode: any): Partial<InteractableNode> {
  const out: Partial<InteractableNode> = {};
  const props = axNode.properties;
  if (!Array.isArray(props)) return out;
  for (const p of props) {
    const v = p.value?.value;
    switch (p.name) {
      case "disabled":
        if (v === true) out.disabled = true;
        break;
      case "checked":
        // AX checked can be "true" | "false" | "mixed"
        if (v === "true" || v === true) out.checked = true;
        else if (v === "mixed") out.checked = "mixed";
        else if (v === "false" || v === false) out.checked = false;
        break;
      case "expanded":
        if (typeof v === "boolean") out.expanded = v;
        break;
      case "pressed":
        if (v === "true" || v === true) out.pressed = true;
        else if (v === "false" || v === false) out.pressed = false;
        break;
      case "selected":
        if (typeof v === "boolean") out.selected = v;
        break;
      case "required":
        if (v === true) out.required = true;
        break;
      case "readonly":
        if (v === true) out.readonly = true;
        break;
      case "focused":
        if (v === true) out.focused = true;
        break;
    }
  }
  return out;
}

interface CachedNode {
  backendNodeId: number;
  objectId?: string;
  // Cached so click/type can skip DOM.describeNode and DOM.getBoxModel round-trips.
  label?: string;
  role?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  inViewport?: boolean;
}

const nodeMaps = new Map<number, Map<string, CachedNode>>();

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "option",
]);

function originOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function flattenFrameTree(node: any): any[] {
  const out: any[] = [node];
  for (const c of node.childFrames ?? []) out.push(...flattenFrameTree(c));
  return out;
}

function normalizeRoleFilter(
  roleMatch?: string | string[]
): Set<string> | null {
  if (!roleMatch) return null;
  const arr = Array.isArray(roleMatch) ? roleMatch : [roleMatch];
  return new Set(arr.map((r) => r.toLowerCase()));
}

function matchesLabel(
  label: string,
  labelMatch?: string,
  caseInsensitive?: boolean
): boolean {
  if (!labelMatch) return true;
  if (caseInsensitive) {
    return label.toLowerCase().includes(labelMatch.toLowerCase());
  }
  return label.includes(labelMatch);
}

export async function getInteractables({
  tabId,
  viewport,
  limit,
  labelMatch,
  roleMatch,
  caseInsensitive,
}: {
  tabId: number;
  viewport?: "visible" | "all";
  limit?: number;
  labelMatch?: string;
  roleMatch?: string | string[];
  caseInsensitive?: boolean;
}) {
  await ensureAttached(tabId);

  // Kick off independent fetches in parallel: AX tree, layout metrics, frame tree.
  const [axMain, layoutVp, frameTree]: any[] = await Promise.all([
    cdp.send(tabId, "Accessibility.getFullAXTree"),
    cdp.send(tabId, "Page.getLayoutMetrics"),
    cdp.send(tabId, "Page.getFrameTree").catch(() => null),
  ]);

  const vw = layoutVp.cssVisualViewport ?? layoutVp.visualViewport;
  const viewportRect = {
    x: vw.pageX ?? 0,
    y: vw.pageY ?? 0,
    w: vw.clientWidth ?? 1280,
    h: vw.clientHeight ?? 720,
  };

  // Walk frames so we can attempt same-origin AX merging and report the cross-origin ones.
  const allFrames = frameTree?.frameTree ? flattenFrameTree(frameTree.frameTree) : [];
  const mainOrigin = originOf(frameTree?.frameTree?.frame?.url);
  const subFrames = allFrames.slice(1); // exclude the main frame

  // Try the AX tree for each subframe in parallel. Cross-origin (OOP) frames usually error
  // or return zero interactive nodes — we surface that to the caller.
  const subFrameAxResults = await Promise.all(
    subFrames.map(async (f) => {
      const frameUrl: string = f.frame.url ?? "";
      const frameOrigin = originOf(frameUrl);
      // Same-origin frames live in the same render process, so the AX tree is reachable.
      try {
        const ax: any = await cdp.send(tabId, "Accessibility.getFullAXTree", {
          frameId: f.frame.id,
        });
        return {
          frameId: f.frame.id,
          url: frameUrl,
          origin: frameOrigin,
          nodes: ax.nodes ?? [],
          accessible: true as const,
          sameOrigin: !!mainOrigin && frameOrigin === mainOrigin,
        };
      } catch (err: any) {
        return {
          frameId: f.frame.id,
          url: frameUrl,
          origin: frameOrigin,
          nodes: [] as any[],
          accessible: false as const,
          sameOrigin: !!mainOrigin && frameOrigin === mainOrigin,
          error: err?.message,
        };
      }
    })
  );

  // Collect candidate nodes from main + any AX-accessible subframes.
  type Candidate = {
    backendNodeId: number;
    role: string;
    label: string;
    state: Partial<InteractableNode>;
    frameId?: string;
  };
  const candidates: Candidate[] = [];
  const seen = new Set<number>();

  const roleFilter = normalizeRoleFilter(roleMatch);
  const collect = (axNodes: any[], frameId?: string) => {
    for (const n of axNodes) {
      const role = n.role?.value;
      if (!role || !INTERACTIVE_ROLES.has(role)) continue;
      if (roleFilter && !roleFilter.has(role.toLowerCase())) continue;
      if (n.ignored) continue;
      const backendNodeId: number | undefined = n.backendDOMNodeId;
      if (!backendNodeId || seen.has(backendNodeId)) continue;
      const rawLabel =
        n.name?.value ??
        n.description?.value ??
        (n.properties ?? [])
          .filter((p: any) => p.name === "value")
          .map((p: any) => String(p.value?.value ?? ""))
          .join(" ");
      const label = String(rawLabel ?? "").slice(0, 200);
      if (!matchesLabel(label, labelMatch, caseInsensitive)) continue;
      seen.add(backendNodeId);
      candidates.push({
        backendNodeId,
        role,
        label,
        state: extractStateFlags(n),
        frameId,
      });
    }
  };

  collect(axMain.nodes ?? []);
  for (const sf of subFrameAxResults) {
    if (sf.accessible) collect(sf.nodes, sf.frameId);
  }

  // Bulk-fetch box models in parallel. This is the big win vs the previous sequential loop
  // — for 100 candidates we go from 100 round-trips to (effectively) 1.
  const boxResults = await Promise.all(
    candidates.map((c) =>
      cdp
        .send(tabId, "DOM.getBoxModel", { backendNodeId: c.backendNodeId })
        .then(
          (b: any) => ({ ok: true as const, box: b }),
          (err: any) => ({ ok: false as const, err })
        )
    )
  );

  const out: InteractableNode[] = [];
  const map = new Map<string, CachedNode>();
  const max = limit ?? 100;
  const wantAll = (viewport ?? "visible") === "all";

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const br = boxResults[i];
    let bounds:
      | { x: number; y: number; width: number; height: number }
      | undefined;
    if (br.ok && br.box?.model?.border) {
      const [x1, y1, x2, , , y3] = br.box.model.border as number[];
      bounds = {
        x: Math.round(x1),
        y: Math.round(y1),
        width: Math.round(x2 - x1),
        height: Math.round(y3 - y1),
      };
    }
    const inViewport = !!(
      bounds &&
      bounds.x + bounds.width > viewportRect.x &&
      bounds.x < viewportRect.x + viewportRect.w &&
      bounds.y + bounds.height > viewportRect.y &&
      bounds.y < viewportRect.y + viewportRect.h
    );
    if (!wantAll && (!bounds || !inViewport)) continue;
    const stableId = `n${c.backendNodeId}`;
    map.set(stableId, {
      backendNodeId: c.backendNodeId,
      label: c.label,
      role: c.role,
      bounds,
      inViewport,
    });
    out.push({
      stableId,
      role: c.role,
      label: c.label,
      tag: undefined,
      bounds,
      inViewport,
      ...c.state,
    });
    if (out.length >= max) break;
  }
  nodeMaps.set(tabId, map);

  // Report frames so the AI doesn't waste round-trips on evalJs spelunking when a page
  // is iframe-heavy. `accessible: false` is the loud signal that content is unreachable.
  const frames = subFrameAxResults.map((sf) => ({
    frameId: sf.frameId,
    url: sf.url,
    origin: sf.origin,
    sameOrigin: sf.sameOrigin,
    accessible: sf.accessible,
    interactableCount: sf.nodes.filter(
      (n: any) => n.role?.value && INTERACTIVE_ROLES.has(n.role.value) && !n.ignored
    ).length,
  }));
  const blockedFrames = frames.filter((f) => !f.accessible);
  const note =
    blockedFrames.length > 0
      ? `${blockedFrames.length} cross-origin iframe(s) are not reachable — their interactables are NOT in this list. Do not use evalJs to probe them; they are isolated by Chrome.`
      : undefined;

  return { nodes: out, viewport: viewportRect, frames, note };
}

function getNode(tabId: number, stableId: string): CachedNode {
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
  // Pass cached label/role so the safety classifier can skip a DOM.describeNode round-trip
  // when the label is obviously not money/destructive.
  const decision = await maybeConfirm(tabId, "click", {
    stableId,
    cachedLabel: n.label,
    cachedRole: n.role,
  });
  if (decision === "denied") return { ok: false, reason: "user-denied" };

  // Fast path: element was reported in the viewport on the last getInteractables call,
  // so we can dispatch the click using cached bounds — no scrollIntoView, no second
  // DOM.getBoxModel round-trip. This is the common case and saves 2 round-trips per click.
  if (n.inViewport && n.bounds) {
    const cx = n.bounds.x + n.bounds.width / 2;
    const cy = n.bounds.y + n.bounds.height / 2;
    await dispatchClick(tabId, cx, cy);
    return { ok: true, x: cx, y: cy };
  }

  await scrollIntoView(tabId, n.backendNodeId);
  const box: any = await cdp.send(tabId, "DOM.getBoxModel", { backendNodeId: n.backendNodeId });
  const [x1, y1, x2, , , y3] = box.model.border as number[];
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y3) / 2;
  await dispatchClick(tabId, cx, cy);
  // Refresh cache so a follow-up click on the same node hits the fast path.
  n.bounds = {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.round(x2 - x1),
    height: Math.round(y3 - y1),
  };
  n.inViewport = true;
  return { ok: true, x: cx, y: cy };
}

// Find an interactable by label substring + optional role, click the Nth match.
// This collapses the common "getInteractables → find → click" three-step pattern into
// a single round-trip: the AI doesn't have to send 100-node payloads back and forth,
// and the action is unambiguous about intent ("click the Follow button for @foo").
export async function clickByLabel({
  tabId,
  labelMatch,
  roleMatch,
  nth,
  caseInsensitive,
  viewport,
}: {
  tabId: number;
  labelMatch: string;
  roleMatch?: string | string[];
  nth?: number;
  caseInsensitive?: boolean;
  viewport?: "visible" | "all";
}) {
  // Reuse getInteractables' filtered output so behavior matches exactly.
  const r = await getInteractables({
    tabId,
    viewport: viewport ?? "visible",
    limit: 500,
    labelMatch,
    roleMatch,
    caseInsensitive,
  });
  const matches = r.nodes;
  const idx = nth ?? 0;
  if (matches.length === 0) {
    return {
      ok: false,
      reason: "no-match",
      matchCount: 0,
      hint: `No visible interactable matched labelMatch=${JSON.stringify(labelMatch)}${
        roleMatch ? `, roleMatch=${JSON.stringify(roleMatch)}` : ""
      }. Try a different substring, viewport:"all", or check that the page has loaded.`,
    };
  }
  if (idx >= matches.length) {
    return {
      ok: false,
      reason: "nth-out-of-range",
      matchCount: matches.length,
      hint: `Asked for nth=${idx} but only ${matches.length} match(es) exist.`,
    };
  }
  const picked = matches[idx];
  const clickResult: any = await click({ tabId, stableId: picked.stableId });
  return {
    ...clickResult,
    matchCount: matches.length,
    clicked: { stableId: picked.stableId, label: picked.label, role: picked.role },
  };
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
  const decision = await maybeConfirm(tabId, "type", {
    stableId,
    sample: text.slice(0, 40),
    cachedLabel: n.label,
    cachedRole: n.role,
  });
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

export async function navigate({
  tabId,
  url,
  waitForLoad,
  waitTimeoutMs,
}: {
  tabId: number;
  url: string;
  waitForLoad?: boolean;
  waitTimeoutMs?: number;
}) {
  const decision = await maybeConfirm(tabId, "navigate", { url });
  if (decision === "denied") return { ok: false, reason: "user-denied" };
  await ensureAttached(tabId);
  await chrome.tabs.update(tabId, { url });
  // Default: block until the network is quiet so the caller doesn't have to chain a
  // separate waitForStable. Pass waitForLoad:false to keep the old fire-and-forget shape.
  if (waitForLoad !== false) {
    const status = await waitForIdle(tabId, waitTimeoutMs ?? 5000);
    return { ok: true, waitStatus: status };
  }
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
  // Prepend a mouseMoved event before pressing. Several Web Component frameworks
  // (Polymer / lit-element, used by YouTube Studio) only mark themselves "active"
  // on pointermove → pointerdown — clicking without the move can leave their internal
  // state machine in a stale step where the `change` event never fires.
  await cdp.send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });
  await cdp.send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
    buttons: 1,
  });
  await cdp.send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
    buttons: 0,
  });
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
