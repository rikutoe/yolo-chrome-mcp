# yolo-chrome-mcp

## Overview

### Purpose
An MCP server that lets an AI see, touch, and debug **any tab in the Chrome you're already using**. Unlike Playwright/Puppeteer-based MCPs that spawn a fresh browser, this one rides on top of your **already-logged-in real session**.

### Background
Existing Chrome MCPs each have gaps: read-only, can't carry over login state, or expose only fragments of console/network. None of them satisfy "let Claude look at this tab I'm on and operate it."

### Goal
- 17 tools work against a real Chrome tab from Claude Code ✅
- Destructive actions are gated by an in-tab confirmation overlay ✅
- Three distribution channels (npm/npx, MCPB, GitHub Release zip) are operational ✅
- v0.1.0 published to npm so anyone can run `claude mcp add yolo-chrome -- npx -y yolo-chrome-mcp@latest`

### Out of Scope
- Multiple Chrome profiles / switching user sessions
- Headless Chrome (this MCP targets the Chrome the user is already using)
- Chrome Web Store listing (for now: GitHub Release zip + unpacked load)

## Current Phase
- Phase 1: Implementation (extension + MCP server + safety overlay) ✅
- Phase 2: Distribution pipeline (npm + MCPB + Actions) ✅
- **Phase 3: First public release** ← current
- Phase 4: Adoption and improvement (more tools, Web Store, deeper docs)

## Next
- [ ] Add `NPM_TOKEN` to repo Settings → Secrets
- [ ] `git tag v0.1.0 && git push origin v0.1.0` to run the release workflow (npm publish + GitHub Release)
- [ ] Run the full 17-tool E2E (including click/type/navigate) from Rikuto's Claude Code and record evidence

## Architecture

```
Claude ⇄ stdio ⇄ MCP server (Node)  ⇄ ws://127.0.0.1:8765 ⇄ Chrome extension (MV3)
                                                              └── chrome.debugger (CDP) → tab
```

### Directory layout

```
server/                Node + TypeScript MCP server
  src/index.ts         Entry + CLI subcommands (install/--version/--help)
  src/bridge.ts        Single-client WS hub to the extension
  src/tools.ts         17 tool definitions (zod schemas)
  src/install.ts       `npx yolo-chrome-mcp install` helper
  src/zodToJsonSchema.ts  Minimal converter (no extra dep)
  prepack.mjs          Copies ../extension/dist into ./extension before publish

extension/             MV3 Chrome extension
  manifest.json        permissions: tabs/debugger/storage/scripting/cookies/alarms
  src/background.ts    WS client + handler routing + alarms keepalive
  src/cdp.ts           Thin chrome.debugger wrapper
  src/session.ts       Per-tab CDP attach + console/network ring buffers
  src/handlers.ts      Handler implementations for all 17 tools
  src/safety.ts        Risky-action classifier (label / submit / cross-origin / etc.)
  src/overlay.ts       In-tab confirmation overlay (Shadow DOM)
  src/overlayBridge.ts Injects overlay.js then round-trips a yes/no message
  src/popup.ts         Extension popup (connection status + safety mode)
  build.mjs            esbuild bundler

shared/                Wire protocol types (unused at the moment; types are inlined in server/extension)

mcpb/manifest.json     Manifest for the Claude Desktop MCPB bundle
scripts/build-mcpb.mjs Produces build/yolo-chrome-mcp-*.mcpb
scripts/e2e.mjs        Stdio E2E driver that exercises tools
.github/workflows/release.yml  Tag-push → npm publish + GitHub Release
```

### Key data shapes
- **stableId**: ID returned by `getInteractables`, formatted as `n{backendNodeId}`. Used as the argument to `click` / `type`. AI never deals with coordinates.
- **Ring buffers**: 500 entries each for console and network. CDP events push into them; oldest entries are dropped when full.
- **Safety mode**: `always` / `dangerous-only` (default) / `off`. Persisted in `chrome.storage.local`.

## Decisions

- **D1: No tab opt-in toggle in the extension** — Rikuto's stance is "hand AI the whole thing and let it figure it out." Risky actions are gated by the overlay instead. (2026-05-14)
- **D2: Tools are split by granularity into stages 1–5** — Single-shot snapshot tools waste context. The MCP `instructions` field nudges the standard flow (listTabs → one visual tool → structure/drill-down). (2026-05-14)
- **D3: DOM is exposed as accessibility-tree interactables, not raw HTML** — role/label/stableId/coords are enough. (2026-05-14)
- **D4: WS is single-client (last writer wins)** — One 1:1 connection between extension and MCP server. Concurrent Claude sessions are out of scope for now. (2026-05-14)
- **D5: shared/ workspace exists but is unused** — TypeScript rootDir/paths fought with the monorepo, so types are duplicated inline in server and extension. Revisit if we genuinely need to share more code. (2026-05-14)
- **D6: MV3 service worker keepalive via `chrome.alarms` every 15s** — Avoids needing an offscreen document (and the extra permission). On each alarm, reconnect if the socket is dead. (2026-05-14)
- **D7: Three distribution paths** — npm/npx (Claude Code), MCPB (Claude Desktop), GitHub Release zip (extension only, manual). Don't wait on Chrome Web Store review. (2026-05-14)
- **D8: Root package is named `yolo-chrome-mcp-monorepo`** — Clashed with the publishable `server/` package name `yolo-chrome-mcp` and broke `npm run -w`. (2026-05-14)
