# yolo-chrome-mcp

## Overview

### Purpose
An MCP server that lets an AI see, touch, and debug **any tab in the Chrome you're already using**. Unlike Playwright/Puppeteer-based MCPs that spawn a fresh browser, this one rides on top of your **already-logged-in real session**.

### Background
Existing Chrome MCPs each have gaps: read-only, can't carry over login state, or expose only fragments of console/network. None of them satisfy "let Claude look at this tab I'm on and operate it."

### Goal
- 22 tools work against a real Chrome tab from Claude Code ✅
- Destructive actions are gated by an in-tab confirmation overlay ✅
- Three distribution channels (npm/npx, MCPB, GitHub Release zip) are operational ✅
- Published on npm — `claude mcp add yolo-chrome -- npx -y yolo-chrome-mcp@latest` works ✅
- Realistic end-to-end flows (navigate → scroll → click → form-fill) finish in well under 15s on a heavy injected DOM ✅ (currently ~2.6s on the bench)

### Out of Scope
- Multiple Chrome profiles / switching user sessions
- Headless Chrome (this MCP targets the Chrome the user is already using)
- Chrome Web Store listing (for now: GitHub Release zip + unpacked load)

## Current Phase
- Phase 1: Implementation (extension + MCP server + safety overlay) ✅
- Phase 2: Distribution pipeline (npm + MCPB + Actions) ✅
- Phase 3: First public release (v0.1.0 → v0.2.3 tagged) ✅
- **Phase 4: Adoption and improvement** ← current (perf + Web Component reliability)

## Next
- [ ] Tag v0.2.4 once the Web-Component findings ship (clickStrategy is in main, awaiting in-the-wild verification of the Monetization-radio bug)

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
  src/tools.ts         22 tool definitions (zod schemas)
  src/install.ts       `npx yolo-chrome-mcp install` helper
  src/zodToJsonSchema.ts  Minimal converter (no extra dep)
  prepack.mjs          Copies ../extension/dist into ./extension before publish

extension/             MV3 Chrome extension
  manifest.json        permissions: tabs/debugger/storage/scripting/cookies/alarms
  src/background.ts    WS client + handler routing + alarms keepalive
  src/cdp.ts           Thin chrome.debugger wrapper
  src/session.ts       Per-tab CDP attach + console/network ring buffers
  src/handlers.ts      Handler implementations for all 22 tools
  src/safety.ts        Risky-action classifier (money labels / account-destructive / password forms / cc & password input)
  src/overlay.ts       In-tab confirmation overlay (Shadow DOM)
  src/overlayBridge.ts Injects overlay.js then round-trips a yes/no message
  src/popup.ts         Extension popup (connection status + safety mode)
  build.mjs            esbuild bundler

shared/                Wire protocol types (unused at the moment; types are inlined in server/extension)

mcpb/manifest.json     Manifest for the Claude Desktop MCPB bundle
scripts/build-mcpb.mjs Produces build/yolo-chrome-mcp-*.mcpb
scripts/e2e.mjs        Stdio E2E driver that exercises every tool
scripts/bench-flow.mjs Performance bench: browse → scroll → click → form-fill on
                       an injected heavy DOM, asserts total under BENCH_BUDGET_MS
.github/workflows/release.yml  Tag-push → npm publish + GitHub Release
```

### Key data shapes
- **stableId**: ID returned by `getInteractables`, formatted as `n{backendNodeId}`. Used as the argument to `click` / `type`. AI never deals with coordinates. When the cached nodeMap entry is missing (e.g. another tool internally refreshed `getInteractables`), the backendNodeId is parsed straight from the format so old stableIds keep working — they just fall through to the slow click path.
- **Interactable nodes** carry AX state flags when truthy/set: `disabled`, `checked` (true/false/"mixed"), `expanded`, `pressed`, `selected`, `required`, `readonly`, `focused`. Read these before reaching for evalJs.
- **frames array** on every `getInteractables` response: every iframe on the page, including out-of-process cross-origin ones discovered via a DOM scan. Each entry has `accessible: bool` — if false, the content is unreachable by any tool.
- **Ring buffers**: 500 entries each for console and network. CDP events push into them; oldest entries are dropped when full.
- **Safety mode**: `always` / `dangerous-only` (default) / `off`. Persisted in `chrome.storage.local`.
- **Per-call latency**: every tool response carries a `[perf] <name> <ms>ms` sidecar text content item (set `YOLO_PERF=0` to disable). Lets the AI notice when a step gets slow without out-of-band logging.

## Decisions

- **D1: No tab opt-in toggle in the extension** — Rikuto's stance is "hand AI the whole thing and let it figure it out." Risky actions are gated by the overlay instead. (2026-05-14)
- **D2: Tools are split by granularity into stages 1–5** — Single-shot snapshot tools waste context. The MCP `instructions` field nudges the standard flow (listTabs → one visual tool → structure/drill-down). (2026-05-14)
- **D3: DOM is exposed as accessibility-tree interactables, not raw HTML** — role/label/stableId/coords are enough. (2026-05-14)
- **D4: WS is single-client at the extension layer, but the MCP server is multi-session via primary/secondary** — One 1:1 connection between the extension and a single MCP server (the *primary*, which owns the extension port — default 8765). Additional MCP server processes (one per concurrent Claude Code session) detect EADDRINUSE, become *secondaries*, and relay calls to the primary over a sibling-IPC port (default 8766). If the primary dies, secondaries race to bind 8765; the winner is promoted to primary and the rest reconnect. This makes 2..N concurrent Claude Code sessions work without each one needing its own Chrome extension. (2026-05-14)
- **D5: shared/ workspace exists but is unused** — TypeScript rootDir/paths fought with the monorepo, so types are duplicated inline in server and extension. Revisit if we genuinely need to share more code. (2026-05-14)
- **D6: MV3 service worker keepalive via `chrome.alarms` every 15s** — Avoids needing an offscreen document (and the extra permission). On each alarm, reconnect if the socket is dead. (2026-05-14)
- **D7: Three distribution paths** — npm/npx (Claude Code), MCPB (Claude Desktop), GitHub Release zip (extension only, manual). Don't wait on Chrome Web Store review. (2026-05-14)
- **D8: Root package is named `yolo-chrome-mcp-monorepo`** — Clashed with the publishable `server/` package name `yolo-chrome-mcp` and broke `npm run -w`. (2026-05-14)
- **D10: Browser routing is enforced via a PreToolUse hook, set up by `npx yolo-chrome-mcp install`** — MCP `instructions` are advisory and Claude ignored them in practice (Claude jumped straight to `mcp__Claude_in_Chrome__*`). Replaced with a real PreToolUse hook in `~/.claude/settings.json` matching `mcp__Claude_in_Chrome__.*|mcp__Control_Chrome__.*`. The hook script lives at `~/.yolo-chrome-mcp/browser-routing-hook.sh` and returns `{"decision":"block","reason":...}` — telling Claude to use `mcp__yolo-chrome__*` instead, and (when `## Browser routing (yolo-chrome-mcp)` is missing from `~/.claude/CLAUDE.md`) to use `AskUserQuestion` to offer adding it. MCP has no install-time hook for global-config edits, so users run `npx yolo-chrome-mcp install` once — it interactively writes the hook script, registers it in `settings.json`, and appends the rule to `CLAUDE.md`. Idempotent. Removable via `npx yolo-chrome-mcp uninstall-routing`. (2026-05-14)
- **D11: getInteractables batches box-model fetches + caches per-node info; click reuses the cache** — Originally `getInteractables` did one `DOM.getBoxModel` round-trip per interactive node sequentially, making heavy pages take seconds and pushing the AI to `evalJs` for diagnostics. Now box models are batched via `Promise.all`, the nodeMap stores `{label, role, bounds, inViewport}` so `click` skips `scrollIntoView` + `DOM.getBoxModel` when the element is already in the viewport, and the safety classifier short-circuits on the cached AX label before issuing `DOM.describeNode`. The `getInteractables` response also carries a `frames` array listing every iframe with `accessible: bool` so the AI sees cross-origin blockage immediately instead of probing it via `evalJs`. (2026-05-16)
- **D9: Safety overlay scope is "sensitive submission only"** — Navigation never prompts (reversible, low-risk). Generic submit/send/confirm labels も外す。プロンプトが出るのは: 金銭ラベル / 退会・解約・アカウント削除ラベル / パスワード input を含むフォーム内の submit / クレジットカード番号らしき値 or password input への type / 危険な evalJs（cookie・fetch・localStorage 改変）。日常操作で確認ダイアログが出ると AI が止まりすぎるため。 (2026-05-14)
- **D12: navigate auto-waits for network idle (waitForLoad default true) + IDLE_QUIET_MS dropped from 500ms → 250ms** — Earlier AI had to chain a separate `waitForStable` after every `navigate`; now navigate blocks internally. The idle threshold dropped because 500ms was the dominant cost on the bench and 250ms is enough for every modern SPA to be interactable. `waitForStable` itself now resolves on "no Network.* events for IDLE_QUIET_MS" rather than "inflight == 0", so persistent SSE / websocket / long-poll connections (Gmail, Calendar, X, YouTube Studio) don't deadlock it. (2026-05-17)
- **D13: clickByLabel tool — find-and-click in one round-trip, auto visible→all fallback** — The old "getInteractables → find → click" three-step pattern was the most common cause of the AI making one too many round-trips. clickByLabel takes `labelMatch` + optional `roleMatch` and clicks the Nth match. When viewport:"visible" returns zero matches, it transparently retries with viewport:"all" — click()'s built-in scrollIntoView still brings the element on-screen before dispatch. Calling it repeatedly with the same query naturally walks a list (Follow buttons, list items, etc.) because the AX label of the clicked element shifts. (2026-05-17)
- **D14: getInteractables filters server-side by labelMatch / roleMatch / caseInsensitive** — Before, the response was always up to 100 nodes regardless of intent, eating context. Now the filter is applied inside the extension before the box-model fetch, so a "find the Follow button" query ships back 8 nodes instead of 80. (2026-05-17)
- **D15: getInteractables surfaces AX state flags** — `disabled` / `checked` / `expanded` / `pressed` / `selected` / `required` / `readonly` / `focused` come back on each node when truthy/set (omitted when unset to keep payloads small). The motivating bug: a YouTube Studio session forced the AI into `evalJs` to read `button.disabled` because nothing else exposed it. (2026-05-17)
- **D16: Out-of-process cross-origin iframes are detected via a DOM scan and merged into the `frames` array as `accessible: false`** — `Page.getFrameTree` from the parent target silently omits OOP iframes under site isolation (AdSense → payments.google.com, YouTube embeds, etc). A parallel `Runtime.evaluate` enumerates `<iframe>` elements in the DOM and any with a URL not in the frame tree are added with `accessible: false` + the standard "do not probe with evalJs" note. (2026-05-17)
- **D17: stableId is self-recoverable from its `n{backendNodeId}` format** — Tools like `clickByLabel` internally refresh `getInteractables`, which replaces the per-tab nodeMap. Earlier, stableIds the AI had grabbed before a refresh became "Unknown stableId" errors mid-task. Now `getNode` falls back to parsing the backendNodeId out of the stableId itself — the click goes through the slow path (no cached bounds) but works. (2026-05-17)
- **D18: dispatchClick stays at two events (mousePressed + mouseReleased)** — Prepending a `mouseMoved` event causes a reproducible ~5000ms (5004–5012ms) stall per click via `chrome.debugger.sendCommand`, **independent of page heaviness and of the `button`/`buttons` params** (verified 2026-05-17 with a one-off bench: `button:"none"+buttons:0`, `"left"+0`, omitted `button`, and `"left"+1` all hit the same plateau on both a single-button page and a 200-card injected DOM). The flat plateau ≈ 5s strongly implies a CDP-internal ack timeout, not computation. Conclusion: mouseMoved via `chrome.debugger` is fundamentally unusable here; the Web Component "click doesn't dirty the form" path is handled by `clickStrategy:"native"` (see D22) instead. (2026-05-17)
- **D19: tool latency is shipped as a sidecar text content item, not by wrapping the payload** — An earlier attempt folded `_meta.durationMs` into every response object, which broke array-typed results (`listTabs` became `{ value: [...], _meta: ... }`). Now each `tools/call` response emits the primary JSON-serialized payload as `content[0]` plus a `[perf] <toolName> <ms>ms` text item as `content[1]`. Disable with `YOLO_PERF=0`. (2026-05-17)
- **D20: reloadSelf tool — chrome.runtime.reload() from inside the extension** — `extension/dist` changes used to require the user clicking ↻ in `chrome://extensions`. Now there's a `reloadSelf` tool that schedules `chrome.runtime.reload()` with a 50ms grace window so the WS ack flushes first. New Claude Code sessions see the tool immediately; the issuing session keeps a cached tools list until restart. (2026-05-17)
- **D21: scripts/bench-flow.mjs is the performance contract** — A realistic flow (5 navigates with auto-wait + scroll + click + form-fill + 3 clickByLabel hits on an injected Follow list + submit) must finish under `BENCH_BUDGET_MS` (default 15000ms). Current run: ~2.8s across 32 steps (the extra steps cover the clickStrategy probe, see D22). Regressions are easy to spot via the per-step wall-clock printout. (2026-05-17)
- **D23: Single-command installer auto-registers with Claude Code; routing rule is English by default** — Onboarding used to be two commands (`claude mcp add … && npx … install`) and the appended CLAUDE.md routing rule was Japanese-only — both bad for first-time external users. Now `npx -y yolo-chrome-mcp@latest setup` (alias of `install`) auto-detects the `claude` CLI, skips registration when `claude mcp list` already shows `yolo-chrome:`, and otherwise runs `claude mcp add --scope user yolo-chrome -- npx -y yolo-chrome-mcp@latest` itself. If the CLI is missing or the command fails, it prints the exact fallback. The routing rule body is now English by default; set `YOLO_CHROME_LANG=ja` (or run in a `ja_*` LANG) for the Japanese version. README quick-start collapsed to one command. (2026-05-17)
- **D24: Chrome Web Store-installed users get a one-liner via the popup, leveraging D23's auto-register** — The extension is one half of the system; without the local MCP server it does nothing. To avoid a multi-step onboarding for store users, the popup now shows a setup card whenever the WS dot is red, with a copy-paste `npx -y yolo-chrome-mcp@latest install --routing-only` and a one-click Copy button. The new `--routing-only` flag skips the extension-load + open-chrome://extensions step (already done via the store) and reuses D23's `registerWithClaude()` to auto-add the server, then runs the interactive routing hook + CLAUDE.md setup. Single command for the path store users will actually take. (2026-05-17)
- **D25: Injected routing rule is "purpose-based", not "always yolo-chrome"** — The CLAUDE.md block `npx … setup` appends used to say "for any Chrome operation you **must** use yolo-chrome-mcp" and listed `WebFetch` as a forbidden fallback. That over-routed plain public-info research (pricing, news, docs) through the slow one-action-at-a-time UI path and contradicted how Rikuto actually wants it used. Rewrote both `ROUTING_RULE_BLOCK_JA`/`_EN` to: default to `WebSearch`/`WebFetch` for research; use yolo-chrome-mcp only when the task needs the UI directly (logged-in dashboards, WebFetch-empty SPAs, forms, DOM/console/network) or the user explicitly asks for the browser. The forbidden-fallback list keeps `Claude_in_Chrome`/`Control_Chrome`/`computer-use` but drops `WebFetch` (now the default). Heading unchanged so the PreToolUse hook grep and `uninstall-routing` still match. (2026-06-09)
- **D22: click / clickByLabel take a `clickStrategy` param ("events" | "native" | "events+native"); default unchanged** — Adds a `nativeClick(tabId, backendNodeId)` helper that does `DOM.resolveNode` → `Runtime.callFunctionOn` with `function(){ this.click(); }`. `"events"` is the existing `Input.dispatchMouseEvent` press+release path and stays default (vanilla HTML / React / Vue / most pages). `"native"` skips dispatch entirely and produces an `isTrusted: false` event — for Polymer / lit pages (YouTube Studio, Google Cloud Console, Workspace Admin) where the dispatch path visually selects an element but doesn't dirty the form. `"events+native"` runs both in sequence as a backstop for unknown pages. Verified mechanically in `scripts/bench-flow.mjs` (all three modes <40ms, `events+native` fires the click listener exactly twice) and on real YouTube Studio (`scripts/yt-studio-probe.mjs` against the "Show mid-roll ads" checkbox — both `events` and `native` toggle the checkbox and enable Save). The specific Monetization-radio + modal-Submit flow described in the original bug report still needs in-the-wild verification by Rikuto, since reproducing it requires toggling a real video's monetization state — but the escape hatch is in place and proven on a real Polymer control. (2026-05-17)
- **D26: .mcpb bundle version is injected from root package.json at build time, not read from the committed manifest** — `mcpb/manifest.json`'s `version` field used to be the source of truth for the Claude Desktop bundle, but it was outside every version-bump path, so it silently drifted (shipped `yolo-chrome-mcp-0.2.4.mcpb` in the v0.2.7 Release while everything else was 0.2.7). `scripts/build-mcpb.mjs` now reads the root `package.json` version and overwrites `manifest.version` in the staged copy, so the committed field is a template that can't cause drift. (2026-06-09)
