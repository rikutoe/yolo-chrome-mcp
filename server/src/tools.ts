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
      "Capture a screenshot of the tab. Defaults to viewport only — pass fullPage:true only when you really need the whole page."
    ),
    inputSchema: z.object({
      tabId,
      fullPage: z.boolean().optional().default(false),
      format: z.enum(["png", "jpeg"]).optional().default("jpeg"),
      quality: z.number().int().min(1).max(100).optional().default(80),
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
      "Clickable / typable / link elements as a flat list with role, label, stableId, and viewport coordinates. Built from the accessibility tree — no raw HTML. Use the stableId for click/type. Response also includes a `frames` array: every iframe on the page with `accessible: true|false`. If `accessible: false`, that iframe's content is cross-origin and CANNOT be reached by ANY tool here (don't try evalJs — Chrome blocks it). When you see blocked iframes, report that to the user instead of probing further."
    ),
    inputSchema: z.object({
      tabId,
      viewport: z.enum(["visible", "all"]).optional().default("visible"),
      limit: z.number().int().min(1).max(500).optional().default(100),
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
    name: "click",
    description:
      "Click an interactable element by stableId (from getInteractables). May trigger a safety confirmation overlay if classified as dangerous.",
    inputSchema: z.object({
      tabId,
      stableId: z.string(),
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
    description: "Navigate the tab to a URL. Same-tab navigation.",
    inputSchema: z.object({ tabId, url: z.string().url() }),
    handler: (b, i) => b.call("navigate", i, 30000),
  },
  {
    name: "createTab",
    description:
      "Open a NEW Chrome tab at the given URL and return its tab info. Use this instead of navigate when you want to keep the current tab as-is.",
    inputSchema: z.object({
      url: z.string().url(),
      active: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether the new tab should become the foreground tab. Default true."),
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
    name: "setSafetyMode",
    description:
      "Set the safety overlay mode: 'always' (confirm every action), 'dangerous-only' (default — confirm money UI, account-destructive labels, password-form submits, credit-card / password typing, risky evalJs), 'off' (no prompts). Navigation never prompts.",
    inputSchema: z.object({
      mode: z.enum(["always", "dangerous-only", "off"]),
    }),
    handler: (b, i) => b.call("setSafetyMode", i),
  },
];
