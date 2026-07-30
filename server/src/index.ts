#!/usr/bin/env node
import {
  Server,
  type CallToolRequest,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { zodToJsonSchema } from "./zodToJsonSchema.js";
import { ExtensionBridge } from "./bridge.js";
import { tools } from "./tools.js";
import { runInstall, runUninstallRouting } from "./install.js";

// Subcommands
const sub = process.argv[2];
if (sub === "install" || sub === "setup") {
  const routingOnly = process.argv.slice(3).includes("--routing-only");
  await runInstall({ routingOnly });
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
  yolo-chrome-mcp setup              One-command setup: registers the server with Claude Code,
                                     loads the Chrome extension, and (optionally) installs the
                                     PreToolUse routing hook + CLAUDE.md rule. ('install' is an alias.)
  yolo-chrome-mcp setup --routing-only
                                     Skip the extension-load step (use when the extension is
                                     already installed from the Chrome Web Store) and only run
                                     the auto-register + routing hook + CLAUDE.md setup. Same
                                     command is what the popup's "Copy" button offers.
  yolo-chrome-mcp uninstall-routing  Remove the PreToolUse hook and the CLAUDE.md rule.
  yolo-chrome-mcp --version          Print version.

Env:
  YOLO_WS_PORT               WebSocket port the extension connects to (default 8765).
  YOLO_SIBLING_PORT          IPC port secondary MCP servers use to relay through
                             the primary (default YOLO_WS_PORT+1 = 8766).
  YOLO_CHROME_LANG           Force routing-rule language (e.g. 'ja' or 'en'). Falls back to LANG.
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
tell them to run: \`npx -y yolo-chrome-mcp@latest setup\`. This is a one-time,
interactive setup that auto-registers the server with Claude Code, loads the
Chrome extension, installs a PreToolUse hook that blocks other browser tools,
and appends a routing rule to ~/.claude/CLAUDE.md.

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

const listTools = async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  })),
});

// Latency is attached to every successful response so the AI can see, per tool call,
// how long the round-trip actually took. `YOLO_PERF=0` opts out.
const PERF_ON = process.env.YOLO_PERF !== "0";

// The return type is explicit because the handler is no longer an inline
// argument to setRequestHandler: without it the `type: "text"` literals widen
// to `string` and stop matching the SDK's content union.
const callTool = async (req: CallToolRequest): Promise<CallToolResult> => {
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
    // Tell the AI which Chrome profile it just acted on, so it can surface
    // "you're connected to <profile>" to the user. null = unknown/not connected.
    const label = bridge.getProfileLabel();
    const profileTag =
      label !== null ? `[profile] ${label || "(名前未設定)"}` : null;
    // Screenshot returns image; wrap in MCP content shape.
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
      if (profileTag) content.push({ type: "text", text: profileTag });
      return { content };
    }
    // Keep the primary payload shape identical to what the handler returned (so array
    // results like listTabs survive as arrays, not `{ value: [...] }`). Emit the perf
    // info as a separate sidecar text content item — the AI sees both, MCP clients that
    // only read content[0] still see the canonical payload.
    const content: any[] = [
      { type: "text", text: JSON.stringify(result, null, 2) },
    ];
    if (PERF_ON) {
      content.push({ type: "text", text: `[perf] ${tool.name} ${durationMs}ms` });
    }
    if (profileTag) content.push({ type: "text", text: profileTag });
    return { content };
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    const perfTag = PERF_ON ? ` [${durationMs}ms]` : "";
    return {
      isError: true,
      content: [{ type: "text", text: `Error${perfTag}: ${err?.message ?? String(err)}` }],
    };
  }
};

// Protocol revision 2026-07-28 removed the initialize handshake, so a
// connection's opening message decides which era it speaks. serveStdio owns
// that decision and the transport lifetime. `legacy` stays at its default
// 'serve', so clients that still open with `initialize` keep working.
//
// The factory MUST return a FRESH Server on every call. The SDK connects a
// modern probe instance to answer `server/discover`, then discards it by
// CLOSING it if the same connection afterwards falls back to a 2025-era
// opening. Handing back one shared instance made that discard close the live
// server, and the lifecycle hook below then killed the whole process
// mid-connection.
function createServer(): Server {
  const server = new Server(
    { name: "yolo-chrome-mcp", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions }
  );
  server.setRequestHandler("tools/list", listTools);
  server.setRequestHandler("tools/call", callTool);
  return server;
}

serveStdio(createServer);

// Role + readiness messages are emitted from inside bridge.init().

// ---- lifecycle -------------------------------------------------------------
// The WS servers (extension + sibling IPC) keep the event loop alive, so
// without an explicit shutdown path this process outlives its MCP client and
// accumulates as a PPID-1 orphan — one per finished Claude/codex session.
// The SDK's StdioServerTransport only subscribes to stdin 'data'/'error' and
// never notices EOF — still true in the v2 SDK, so do not drop this block on
// the strength of the upgrade alone. The server has to watch its own
// lifelines:
//   1. stdin 'end'/'close'    → the client exited and the pipe drained
//   2. stdout 'error'/'close' → the client stopped reading us (EPIPE) while
//      still holding our stdin open. Under v1 this killed the process anyway,
//      as an unhandled EPIPE 'error' event; v2 routes transport errors through
//      its own handler, so without this line the process survives a dead
//      client and leaks exactly the orphan this block exists to prevent.
//   3. SIGINT/SIGTERM/SIGHUP  → terminal or session teardown
//   4. ppid becomes 1         → parent died without our stdin ever closing
//      (e.g. the npx wrapper was SIGKILLed). No-op where orphans are
//      reparented to a subreaper instead of PID 1 — stdin EOF covers those.
let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`yolo-chrome-mcp: shutting down (${reason})\n`);
  try {
    bridge.close();
  } catch {}
  process.exit(0);
}

// No `server.onclose` hook here on purpose: under serveStdio a Server instance
// can be a throwaway probe — the SDK closes one it discards — so its close says
// nothing about the process. These stream hooks are process-level instead, and
// therefore fire only for the real connection.
process.stdin.on("end", () => shutdown("stdin closed"));
process.stdin.on("close", () => shutdown("stdin closed"));
process.stdout.on("error", () => shutdown("stdout closed"));
process.stdout.on("close", () => shutdown("stdout closed"));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => shutdown(sig));
}
const PPID_CHECK_MS = Number(process.env.YOLO_PPID_CHECK_MS ?? 15_000);
setInterval(() => {
  if (process.ppid === 1) shutdown("parent process died");
}, PPID_CHECK_MS).unref();
