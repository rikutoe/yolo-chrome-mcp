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
import { runInstall } from "./install.js";

// Subcommands
const sub = process.argv[2];
if (sub === "install") {
  await runInstall();
  process.exit(0);
}
if (sub === "--help" || sub === "-h") {
  process.stdout.write(`yolo-chrome-mcp — Chrome MCP server.

Usage:
  yolo-chrome-mcp            Start the MCP server on stdio (default; used by Claude).
  yolo-chrome-mcp install    Show how to load the Chrome extension into your browser.
  yolo-chrome-mcp --version  Print version.

Env:
  YOLO_WS_PORT               WebSocket port the extension connects to (default 8765).
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
const bridge = new ExtensionBridge(WS_PORT);

const instructions = `
yolo-chrome-mcp lets you observe and control any open Chrome tab.

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

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid arguments for ${tool.name}: ${parsed.error.message}`);
  }
  try {
    const result = await tool.handler(bridge, parsed.data);
    // Screenshot returns image; wrap in MCP content shape.
    if (
      tool.name === "screenshot" &&
      result &&
      typeof result === "object" &&
      "dataBase64" in result
    ) {
      return {
        content: [
          {
            type: "image",
            data: result.dataBase64,
            mimeType: result.mimeType ?? "image/jpeg",
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Surface bridge readiness on stderr for human debugging (stdout is reserved for MCP).
process.stderr.write(`yolo-chrome-mcp: listening for extension on ws://127.0.0.1:${WS_PORT}\n`);
