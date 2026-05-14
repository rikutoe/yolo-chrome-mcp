# yolo-chrome-mcp

Expose every open Chrome tab to an MCP server so AIs can browse, debug, and operate them — using your **already-logged-in** Chrome session.

- 17 tools spanning tab discovery, screenshots, accessibility-tree interactables, console/network/storage, click/type/scroll/navigate, JS eval.
- Staged tool design + filtered defaults keep AI context tight (see [docs/FEATURE_PLAN.md](docs/FEATURE_PLAN.md)).
- An in-tab safety overlay confirms destructive actions (form submits, money-ish labels, cross-origin nav, risky `evalJs`).

## Install

You need both halves: the MCP server (driven by Claude) and the Chrome extension (loaded once into your Chrome).

### Option A — Claude Code (npx, recommended)

```bash
claude mcp add --scope user yolo-chrome -- npx -y yolo-chrome-mcp@latest
npx yolo-chrome-mcp install        # extension load + routing hook + CLAUDE.md rule
```

**Important**: pass `--scope user`. Without it the server is registered only for the directory you ran the command from, and Claude in other projects will report "Failed to connect".

The `install` step does three things, with prompts:

1. **Extension load** — opens `chrome://extensions` and copies the extension folder path to your clipboard. In the file dialog: `Cmd/Ctrl+Shift+G` → `Cmd/Ctrl+V` → Select.
2. **PreToolUse hook** (recommended) — writes `~/.yolo-chrome-mcp/browser-routing-hook.sh` and registers it in `~/.claude/settings.json` matching `mcp__Claude_in_Chrome__.*|mcp__Control_Chrome__.*`. When Claude tries to use a competing browser tool, the hook blocks and tells Claude to use `mcp__yolo-chrome__*` instead.
3. **CLAUDE.md routing rule** (recommended) — appends a `## Browser routing (yolo-chrome-mcp)` section to `~/.claude/CLAUDE.md` so Claude has a persistent reason in plain language.

Re-running `install` is idempotent. To remove the hook + rule later: `npx yolo-chrome-mcp uninstall-routing`.

### Option B — Claude Desktop (MCPB one-click)

1. Download the latest `yolo-chrome-mcp-*.mcpb` from [Releases](https://github.com/rikutoe/yolo-chrome-mcp/releases).
2. Drag it onto Claude Desktop.
3. Inside the bundle there is an `extension/` folder — load it as an unpacked extension at `chrome://extensions`.

### Option C — Build from source

```bash
git clone https://github.com/rikutoe/yolo-chrome-mcp
cd yolo-chrome-mcp
npm install
npm run build
claude mcp add yolo-chrome -- node $(pwd)/server/dist/index.js
# Then load extension/dist via chrome://extensions → Load unpacked
```

## How it works

```
Claude ⇄ stdio ⇄ MCP server (Node)  ⇄ ws://127.0.0.1:8765 ⇄ Chrome extension (MV3)
                                                              └── chrome.debugger (CDP) → tab
```

The Chrome extension stays alive in your real Chrome profile. The MCP server is spawned per-Claude-session and connects locally over WebSocket — nothing leaves your machine.

## Tools

| Tool | Stage | Purpose |
|---|---|---|
| `listTabs` | 1 | All open tabs |
| `getTabInfo` | 1 | One tab's metadata |
| `screenshot` | 2 | Viewport screenshot (fullPage opt-in) |
| `getPageText` | 2 | Visible text, paginated |
| `getInteractables` | 3 | Clickable elements via a11y tree |
| `getConsoleLogs` | 4 | Filtered console buffer |
| `getNetworkActivity` | 4 | Filtered network summary |
| `getNetworkRequest` | 4 | One request, full details |
| `getStorage` | 4 | cookie / localStorage / sessionStorage |
| `getSourceAt` | 5 | JS source ±N lines |
| `click` / `type` / `scroll` | — | UI actions by stableId |
| `navigate` | — | Same-tab navigation |
| `evalJs` | — | Last-resort JS eval |
| `waitForStable` | — | Wait for network-idle |
| `setSafetyMode` | — | `always` / `dangerous-only` / `off` |

## Safety overlay

In `dangerous-only` mode (default) the extension shows a yellow confirmation banner in the tab whenever the AI tries to:

- Click an element labelled `submit` / `delete` / `送信` / `削除`, or a `type=submit` input, or text matching a money-ish pattern (`¥`, `$`, etc.)
- Navigate across origins
- Run `evalJs` that touches cookies, network, or storage
- Type something that looks like a credit-card number

Switch modes from the popup or via the `setSafetyMode` tool.

## Distribution / Release

Tag and push:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The release workflow builds, publishes to npm with provenance, and attaches `*.mcpb` and `extension.zip` to the GitHub release.

Required repo secret: `NPM_TOKEN`.

## License

MIT
