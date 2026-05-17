#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./zodToJsonSchema.js";
import { ExtensionBridge } from "./bridge.js";
import { tools } from "./tools.js";
import { runInstall, runUninstallRouting } from "./install.js";

// Subcommands
const sub = process.argv[2];
if (sub === "install") {
  await runInstall();
  process.exit(0);
}
if (sub === "uninstall-routing") {
  await runUninstallRouting();
  process.exit(0);
}
if (sub === "--help" || sub === "-h") {
  process.stdout.write(`yolo-chrome-mcp — Chrome MCP server.

Usage:
  yolo-chrome-mcp                    Start the MCP server on stdio (default; used by Claude).
  yolo-chrome-mcp install            Interactive installer: extension load + routing hook + CLAUDE.md rule.
  yolo-chrome-mcp uninstall-routing  Remove the PreToolUse hook and the CLAUDE.md rule.
  yolo-chrome-mcp --version          Print version.

Env:
  YOLO_WS_PORT               WebSocket port the extension connects to (default 8765).
  YOLO_SIBLING_PORT          IPC port secondary MCP servers use to relay through
                             the primary (default YOLO_WS_PORT+1 = 8766).
`);
  process.exit(0);
}
if (sub === "--version" || sub === "-v") {
  // Read package.json next to dist/.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

const WS_PORT = Number(process.env.YOLO_WS_PORT ?? 8765);
const SIBLING_PORT = Number(process.env.YOLO_SIBLING_PORT ?? WS_PORT + 1);
const bridge = new ExtensionBridge(WS_PORT, SIBLING_PORT);

const instructions = `
yolo-chrome-mcp lets you observe and control any open Chrome tab.

For Chrome operations always prefer this server's tools (mcp__yolo-chrome__*).
If the user has not yet wired up routing (PreToolUse hook + CLAUDE.md rule),
tell them to run: \`npx yolo-chrome-mcp install\`. This is a one-time, interactive
setup that installs the Chrome extension, a PreToolUse hook that blocks other
browser tools, and a routing rule in ~/.claude/CLAUDE.md.

Standard flow (keep context tight — do not skip stages):
  1. listTabs            → pick the target tab
  2. screenshot or       → understand the visual state (one, not both)
     getPageText
  3. getInteractables    → only when you need to click or type
  4. getConsoleLogs /    → drill into errors. ALWAYS pass filters.
     getNetworkActivity
  5. getSourceAt         → resolve a stack trace line

Hard rules:
  - Never call getInteractables with viewport:'all' unless the visible viewport gave you nothing.
  - Never call evalJs when a dedicated tool exists.
  - Click/type by stableId from getInteractables — never by coordinate.
  - After navigate or a clicking action that reloads, call waitForStable before the next read.

The extension must be installed and running. If a tool returns a 'not connected' error,
ask the user to open chrome://extensions, ensure 'yolo-chrome-mcp' is enabled, and reload.
`.trim();

const server = new Server(
  { name: "yolo-chrome-mcp", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  })),
}));

// Latency is attached to every successful response so the AI can see, per tool call,
// how long the round-trip actually took. `YOLO_PERF=0` opts out.
const PERF_ON = process.env.YOLO_PERF !== "0";

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid arguments for ${tool.name}: ${parsed.error.message}`);
  }
  const t0 = Date.now();
  try {
    const result = await tool.handler(bridge, parsed.data);
    const durationMs = Date.now() - t0;
    // Screenshot returns image; wrap in MCP content shape. We tuck the latency into
    // a tiny text block alongside the image so the AI can still see it.
    if (
      tool.name === "screenshot" &&
      result &&
      typeof result === "object" &&
      "dataBase64" in result
    ) {
      const content: any[] = [
        {
          type: "image",
          data: result.dataBase64,
          mimeType: result.mimeType ?? "image/jpeg",
        },
      ];
      if (PERF_ON) {
        content.push({ type: "text", text: `[perf] ${tool.name} ${durationMs}ms` });
      }
      return { content };
    }
    // For JSON results, fold _meta.durationMs into the object so it shows up in the
    // text payload the AI reads back. Falls back to a sidecar perf line when result is
    // not a plain object.
    let payload: any = result;
    if (PERF_ON) {
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        payload = { ...payload, _meta: { ...(payload._meta ?? {}), durationMs } };
      } else {
        payload = { value: payload, _meta: { durationMs } };
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    const perfTag = PERF_ON ? ` [${durationMs}ms]` : "";
    return {
      isError: true,
      content: [{ type: "text", text: `Error${perfTag}: ${err?.message ?? String(err)}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Role + readiness messages are emitted from inside bridge.init().
