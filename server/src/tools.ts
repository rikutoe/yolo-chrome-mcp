import { z } from "zod";
import type { ExtensionBridge } from "./bridge.js";

// Each MCP tool is just a thin pass-through to the extension via WS.
// Schemas validate AI inputs; the extension does the real work.

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (bridge: ExtensionBridge, input: any) => Promise<any>;
}

const tabId = z.number().int().describe("Chrome tab id from listTabs");

const stage = (n: number, body: string) =>
  `[Stage ${n}] ${body} Prefer lower-stage tools first; pass filters to keep responses small.`;

export const tools: ToolDef[] = [
  {
    name: "listTabs",
    description: stage(
      1,
      "List all open Chrome tabs (id, title, url, active, windowId). Always call this first to locate the target tab."
    ),
    inputSchema: z.object({}),
    handler: (b) => b.call("listTabs", {}),
  },
  {
    name: "getTabInfo",
    description: stage(
      1,
      "Lightweight metadata for a single tab: favicon, opened-at, frame tree summary. Cheap — use to confirm the tab before heavier calls."
    ),
    inputSchema: z.object({ tabId }),
    handler: (b, i) => b.call("getTabInfo", i),
  },
  {
    name: "screenshot",
    description: stage(
      2,
      "Capture a screenshot of the tab. Defaults to viewport-only jpeg at quality 60 (≈100KB for a 1440px viewport — small enough to be cheap to take). Pass fullPage:true or higher quality only when you really need it. Don't take a screenshot between every action — call this when you need to UNDERSTAND visual state, not to confirm an action you already verified."
    ),
    inputSchema: z.object({
      tabId,
      fullPage: z.boolean().optional().default(false),
      format: z.enum(["png", "jpeg"]).optional().default("jpeg"),
      quality: z.number().int().min(1).max(100).optional().default(60),
    }),
    handler: (b, i) => b.call("screenshot", i, 30000),
  },
  {
    name: "getPageText",
    description: stage(
      2,
      "Visible text content of the page (no markup). Default returns first 2000 chars with truncated flag. Use offset to paginate."
    ),
    inputSchema: z.object({
      tabId,
      offset: z.number().int().min(0).optional().default(0),
      maxChars: z.number().int().min(100).max(20000).optional().default(2000),
    }),
    handler: (b, i) => b.call("getPageText", i),
  },
  {
    name: "getInteractables",
    description: stage(
      3,
      "Clickable / typable / link elements as a flat list with role, label, stableId, viewport coordinates, AND state flags (disabled, checked, expanded, pressed, selected, required, readonly, focused — only present when truthy/set, so absence means 'no signal'). Built from the accessibility tree — no raw HTML. Use the stableId for click/type. Pass labelMatch (substring) and/or roleMatch to filter — strongly prefer this over scanning a full 100-node response. **Always read state flags before falling back to evalJs** — e.g. don't run evalJs to check `button.disabled` when this tool already returns `disabled: true` on the node. Response also includes a `frames` array: every iframe on the page with `accessible: true|false`. If `accessible: false`, that iframe's content is cross-origin and CANNOT be reached by ANY tool here (don't try evalJs — Chrome blocks it). When you only need to click one specific element you already know how to identify, use clickByLabel instead — it bundles find+click into one call."
    ),
    inputSchema: z.object({
      tabId,
      viewport: z.enum(["visible", "all"]).optional().default("visible"),
      limit: z.number().int().min(1).max(500).optional().default(100),
      labelMatch: z
        .string()
        .optional()
        .describe(
          "Substring filter on the accessible label. Cheap and dramatically shrinks the response."
        ),
      roleMatch: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Role filter — 'button', 'link', 'textbox', etc. Single string or array."),
      caseInsensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Case-insensitive labelMatch. Default false to keep matches predictable."),
    }),
    handler: (b, i) => b.call("getInteractables", i, 30000),
  },
  {
    name: "getConsoleLogs",
    description: stage(
      4,
      "Recent console logs from the tab (ring buffer). Filter with level and since (epoch ms). Default returns last 20 errors."
    ),
    inputSchema: z.object({
      tabId,
      level: z.enum(["log", "info", "warning", "error", "all"]).optional().default("error"),
      since: z.number().optional(),
      limit: z.number().int().min(1).max(500).optional().default(20),
    }),
    handler: (b, i) => b.call("getConsoleLogs", i),
  },
  {
    name: "getNetworkActivity",
    description: stage(
      4,
      "Recent network requests for the tab — summary only (url, method, status, durationMs, sizeBytes, requestId). Default: failedOnly + last 20. Use getNetworkRequest for one request's full headers/body."
    ),
    inputSchema: z.object({
      tabId,
      failedOnly: z.boolean().optional().default(true),
      since: z.number().optional(),
      limit: z.number().int().min(1).max(500).optional().default(20),
    }),
    handler: (b, i) => b.call("getNetworkActivity", i),
  },
  {
    name: "getNetworkRequest",
    description: stage(
      4,
      "Full details for a single network request: headers, request body, response body (if captured). Use sparingly — can be large."
    ),
    inputSchema: z.object({
      tabId,
      requestId: z.string(),
    }),
    handler: (b, i) => b.call("getNetworkRequest", i, 30000),
  },
  {
    name: "getStorage",
    description: stage(
      4,
      "Storage contents for the tab. Specify types to limit scope; nothing is returned for omitted types."
    ),
    inputSchema: z.object({
      tabId,
      types: z
        .array(z.enum(["cookie", "localStorage", "sessionStorage"]))
        .min(1)
        .default(["cookie"]),
    }),
    handler: (b, i) => b.call("getStorage", i),
  },
  {
    name: "getSourceAt",
    description: stage(
      5,
      "JS source snippet around a (url, line) location with sourcemap resolution. Returns ±10 lines by default."
    ),
    inputSchema: z.object({
      tabId,
      url: z.string(),
      line: z.number().int().min(0),
      range: z.number().int().min(1).max(100).optional().default(10),
    }),
    handler: (b, i) => b.call("getSourceAt", i, 30000),
  },
  {
    name: "clickByLabel",
    description: stage(
      3,
      "Find a visible interactable by label substring (and optional role) and click it in ONE call. Strongly preferred over getInteractables+click when you know what you want — no payload to scan, no stableId bookkeeping. For repeating UI patterns like a list of Follow buttons, just call this multiple times in a row; after each click the AX tree shifts (the clicked button's label changes), so calling with nth:0 each time naturally walks the list. Returns {ok, matchCount, clicked} on success or {ok:false, reason} when no match / nth out of range."
    ),
    inputSchema: z.object({
      tabId,
      labelMatch: z
        .string()
        .min(1)
        .describe("Substring of the accessible label, e.g. 'Follow @' or 'Submit'."),
      roleMatch: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Optional role filter — 'button', 'link', etc."),
      nth: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Pick the Nth match (0-indexed). Default 0."),
      caseInsensitive: z.boolean().optional().default(false),
      viewport: z
        .enum(["visible", "all"])
        .optional()
        .default("visible")
        .describe("'visible' is almost always right; 'all' is for off-screen elements."),
      clickStrategy: z
        .enum(["events", "native", "events+native"])
        .optional()
        .default("events")
        .describe(
          "Same as click.clickStrategy. Use 'native' on Polymer / lit pages (YouTube Studio, etc.) where the default 'events' click visually selects but doesn't dirty the form."
        ),
    }),
    handler: (b, i) => b.call("clickByLabel", i, 30000),
  },
  {
    name: "click",
    description:
      "Click an interactable element by stableId (from getInteractables). May trigger a safety confirmation overlay if classified as dangerous. On Web Component pages (YouTube Studio, Google Cloud Console, Workspace Admin) where the default dispatch-based click visually selects an element but doesn't dirty the form / enable the Save button, retry with clickStrategy:'native'.",
    inputSchema: z.object({
      tabId,
      stableId: z.string(),
      clickStrategy: z
        .enum(["events", "native", "events+native"])
        .optional()
        .default("events")
        .describe(
          "'events' (default): Input.dispatchMouseEvent press+release — right for vanilla HTML / React / Vue. 'native': element.click() via Runtime.callFunctionOn — use on Polymer / lit pages where 'events' visually clicks but doesn't dirty the form. 'events+native': both in sequence, for unknown / mixed pages."
        ),
    }),
    handler: (b, i) => b.call("click", i, 30000),
  },
  {
    name: "type",
    description:
      "Type text into an input/textarea identified by stableId. Sends real keyboard events so framework listeners fire.",
    inputSchema: z.object({
      tabId,
      stableId: z.string(),
      text: z.string(),
      clearFirst: z.boolean().optional().default(true),
      pressEnter: z.boolean().optional().default(false),
    }),
    handler: (b, i) => b.call("type", i, 30000),
  },
  {
    name: "scroll",
    description:
      "Scroll the tab. Provide either {to: {x, y}} for absolute or {by: {x, y}} for relative.",
    inputSchema: z.object({
      tabId,
      to: z.object({ x: z.number(), y: z.number() }).optional(),
      by: z.object({ x: z.number(), y: z.number() }).optional(),
    }),
    handler: (b, i) => b.call("scroll", i),
  },
  {
    name: "navigate",
    description:
      "Navigate the tab to a URL. Same-tab navigation. By default this BLOCKS until the network is quiet (no need to chain waitForStable afterwards). Pass waitForLoad:false to return as soon as navigation starts.",
    inputSchema: z.object({
      tabId,
      url: z.string().url(),
      waitForLoad: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "When true (default), waits for network idle before returning so the next tool call sees the loaded page."
        ),
      waitTimeoutMs: z
        .number()
        .int()
        .min(100)
        .max(60000)
        .optional()
        .default(5000),
    }),
    handler: (b, i) => b.call("navigate", i, 65000),
  },
  {
    name: "createTab",
    description:
      "Open a NEW Chrome tab at the given URL and return its tab info. Use this instead of navigate when you want to keep the current tab as-is. Opens in the BACKGROUND by default so the user's current tab keeps focus; pass active:true only when you specifically need it in the foreground.",
    inputSchema: z.object({
      url: z.string().url(),
      active: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether the new tab should become the foreground tab. Default false (opens in background, keeps the user's current tab focused)."),
      windowId: z
        .number()
        .int()
        .optional()
        .describe("Open the tab in a specific window. Defaults to the focused window."),
    }),
    handler: (b, i) => b.call("createTab", i, 15000),
  },
  {
    name: "closeTab",
    description:
      "Close one or more Chrome tabs by id. Returns the ids that were closed.",
    inputSchema: z.object({
      tabIds: z
        .union([z.number().int(), z.array(z.number().int()).min(1)])
        .describe("Single tabId or an array of tabIds to close."),
    }),
    handler: (b, i) => b.call("closeTab", i, 15000),
  },
  {
    name: "evalJs",
    description:
      "Evaluate a JavaScript expression in the tab's main world and return the result (JSON-serialized). LAST RESORT — do not use for page inspection. For 'what's on this page?' use screenshot + getPageText + getInteractables (in that order). For 'why is this iframe empty?' check the `frames` field returned by getInteractables — cross-origin iframes are unreachable and evalJs will not bypass that. Only reach for evalJs when you genuinely need to run page-specific JS that no dedicated tool covers. Destructive expressions go through the safety overlay.",
    inputSchema: z.object({
      tabId,
      expression: z.string(),
      awaitPromise: z.boolean().optional().default(true),
    }),
    handler: (b, i) => b.call("evalJs", i, 30000),
  },
  {
    name: "waitForStable",
    description:
      "Wait until the tab reaches network-idle (no in-flight requests for ~500ms). Use after navigate/click that triggers a reload.",
    inputSchema: z.object({
      tabId,
      timeout: z.number().int().min(100).max(60000).optional().default(5000),
    }),
    handler: (b, i) => b.call("waitForStable", i, 65000),
  },
  {
    name: "reloadSelf",
    description:
      "Reload the yolo-chrome extension itself (chrome.runtime.reload). Use after rebuilding extension/dist so a new background.js is loaded without the user clicking the ↻ in chrome://extensions. The WS connection drops on reload — the next tool call will hang briefly while the extension reconnects (≤15s, usually <2s). Returns immediately; do NOT call repeatedly.",
    inputSchema: z.object({}),
    handler: (b) => b.call("reloadSelf", {}, 5000),
  },
  {
    name: "setSafetyMode",
    description:
      "Set the safety overlay mode: 'always' (confirm every action), 'dangerous-only' (default — confirm money UI, account-destructive labels, password-form submits, credit-card / password typing, risky evalJs), 'off' (no prompts). Navigation never prompts.",
    inputSchema: z.object({
      mode: z.enum(["always", "dangerous-only", "off"]),
    }),
    handler: (b, i) => b.call("setSafetyMode", i),
  },
];
