# yolo-chrome-mcp

Expose every open Chrome tab to an MCP server so AIs can browse, debug, and operate them — using your **already-logged-in** Chrome session.

- 17 tools spanning tab discovery, screenshots, accessibility-tree interactables, console/network/storage, click/type/scroll/navigate, JS eval.
- Staged tool design + filtered defaults keep AI context tight (see [docs/FEATURE_PLAN.md](docs/FEATURE_PLAN.md)).
- An in-tab safety overlay confirms destructive actions (form submits, money-ish labels, cross-origin nav, risky `evalJs`).

## Install

**One command (Claude Code):**

```bash
npx -y yolo-chrome-mcp@latest setup
```

That's it. The installer:

1. **Registers the MCP server** with Claude Code as `yolo-chrome` (`--scope user`, so it works in every project).
2. **Opens `chrome://extensions`** and copies the extension folder path to your clipboard — toggle "Developer mode", click "Load unpacked", paste (`Cmd/Ctrl+V`), Select.
3. **Installs a PreToolUse routing hook** (optional, prompted) that blocks competing browser tools (`Claude_in_Chrome`, `Control_Chrome`) so Claude always uses this server for Chrome operations.
4. **Appends a routing rule to `~/.claude/CLAUDE.md`** (optional, prompted) so Claude has a persistent reason in plain language. Set `YOLO_CHROME_LANG=ja` for the Japanese rule; otherwise English.

Re-running `setup` is idempotent. To remove the hook + rule later: `npx yolo-chrome-mcp uninstall-routing`.

**Already installed the extension from the Chrome Web Store?** Skip the "Load unpacked" step with:

```bash
npx -y yolo-chrome-mcp@latest setup --routing-only
```

This is the exact same command the extension popup shows (with a one-click Copy button) when its status dot is red. It auto-registers the MCP server with Claude Code and runs the routing setup, without re-opening `chrome://extensions`.

### Other clients

- **Claude Desktop (MCPB one-click)** — download the latest `yolo-chrome-mcp-*.mcpb` from [Releases](https://github.com/rikutoe/yolo-chrome-mcp/releases), drag onto Claude Desktop, then load the bundle's `extension/` folder via `chrome://extensions` → Load unpacked.
- **From source (devs)**:
  ```bash
  git clone https://github.com/rikutoe/yolo-chrome-mcp
  cd yolo-chrome-mcp && npm install && npm run build
  claude mcp add --scope user yolo-chrome -- node $(pwd)/server/dist/index.js
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
