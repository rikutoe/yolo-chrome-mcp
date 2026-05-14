# yolo-chrome-mcp implementation plan ── hand your real Chrome to an AI: let it look, click, and fix

**Created:** 2026-05-14
**Status:** Draft
**Related:** (none. New project.)

---

## 1. Background

Existing Chrome-operating MCPs (Claude in Chrome, Control Chrome, Preview, etc.) each have a different gap: "good at reading but weak at writing," "spawns a fresh browser so logged-in sessions don't carry over," "console and network only come in fragments." What we actually want is for the AI to enter the Chrome **we are already using** — the tabs that are already logged in, the extensions, the open workspace — and see, touch, debug, and (when needed) fix things, all in one loop.

Goal for this iteration: **make any tab in the user's current Chrome instantly handable to the AI.** Pick a tab; the AI can see the screen, DOM, console, network, and storage, can operate it, and can even modify code when paired with a local dev workflow.

---

## 2. Target experiences

### Experience 1 ── The AI can find and pick its own tab

**What the user sees:**
The user just says vague things like "there's something weird on the GitHub PR page." The AI calls `listTabs` behind the scenes, reads the titles/URLs, and identifies the target tab on its own. There is no opt-in or toggle — whatever's open in Chrome is fair game. After locking onto the tab, the AI can call `getTabInfo(tabId)` for that tab's extra details if needed.

**Context:**
Asking the user to "pick the tab" pushes work back onto them. Rikuto's stance is **hand AI the whole thing and let AI think**. Risky actions are gated separately by experience 5.

**Implementation direction:**
A Chrome MV3 extension with the `chrome.tabs` permission. Expose two MCP tools: `listTabs()` (all tabs' id/title/url/active) and `getTabInfo(tabId)` (lightweight metadata: favicon, opened-at, frame layout). Heavier payloads belong to experience 2.

---

### Experience 2 ── A separated toolset, each returning only what's needed

**What the user sees:**
The AI fetches exactly what it needs at any moment. "Just the screen" → `screenshot`. "Just console errors" → `getConsoleLogs`. "Just recent network" → `getNetworkActivity`. "I want to navigate" → `getInteractables`, which returns clickable, typable, and link elements with role/label/visibleText/coords. **There is no single tool that dumps the entire DOM.**

**Context:**
"One-shot snapshot" tools are tempting but burn tokens. Real debugging needs change per moment, so splitting tools and letting the AI pick is both cheaper and more accurate. The DOM in particular is wasteful raw — extract only what the AI needs to operate.

**Implementation direction:**
Attach CDP (`chrome.debugger`) to the target tab and expose tools per CDP domain:
- `screenshot(tabId, {fullPage?})` ── image only
- `getConsoleLogs(tabId, {since?, level?})` ── logs only, filterable
- `getNetworkActivity(tabId, {since?, failedOnly?})` ── request summaries
- `getInteractables(tabId, {viewport?})` ── clickable/typable/link nodes with ARIA role + visible text + stable IDs + coords. No raw HTML.
- `getPageText(tabId)` ── visible text only (for reading)
- `getStorage(tabId, {types})` ── cookies / localStorage / sessionStorage on demand

`getInteractables` is built on the accessibility tree (`Accessibility.getFullAXTree`), so role/label are already attached and LLM-friendly.

---

### Experience 3 ── Operate the tab (click, type, scroll, JS eval)

**What the user sees:**
"Fill this form and submit it" actually moves the cursor on the user's screen and submits using the already-logged-in session. JS `eval`s look like they ran in that tab's console.

**Context:**
Spawn-a-fresh-Chrome MCPs (Playwright/Puppeteer) lose login state. Riding the existing session matters for SaaS dashboards and internal tools.

**Implementation direction:**
CDP `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Runtime.evaluate`. Click targets are specified by the stable ID returned by experience 2's `getInteractables` (backendNodeId / AXNodeId). The AI never thinks about pixel coords.

---

### Experience 4 ── The AI can dig errors and slowness all the way down

**What the user sees:**
"This page feels slow" / "there's red in the console" gets a network waterfall summary (durations, failures), the console error with its stack trace, and the JS source line(s) involved. The AI lands on conclusions like "this XHR took 5s and returned 500 — looks server-side."

**Context:**
Real debugging requires Network/Console/Source linked together. Just "send a screenshot to the AI" doesn't get you to root cause.

**Implementation direction:**
Subscribe to CDP `Network.*` / `Console.*` / `Debugger.*` continuously. Expose `getNetworkActivity` / `getConsoleErrors` / `getSourceAt(url, line)`. Resolve sourcemaps on stack traces inside the extension before returning.

---

### Experience 5 ── Risky actions get a one-step confirmation

**What the user sees:**
The moment the AI tries something that smells like "money moves," "data gets deleted," or "data leaves the page" (submit buttons, money-shaped text, delete-style classes), a tab overlay pops up: "AI wants to do X. Allow?" Nothing happens until the user clicks OK. Read-only and harmless navigation flow through without prompts.

**Context:**
"Hand the whole Chrome over" is powerful but the cost of a wrong click is high. The trade is **everything goes through inside the granted tab, but only irreversible-looking actions require a tap**.

**Implementation direction:**
In the SW, classify incoming action requests using heuristics ("target text," `type=submit`, money-shaped strings, delete-style class names). If risky, a content script paints a fullscreen confirmation overlay. The mode (always confirm / dangerous-only / off) is configurable from the popup.

---

### Experience 6 ── Code edits loop back into the open page

**What the user sees:**
While developing a web app locally, "this button is misaligned, fix it" turns into: AI edits source → browser auto-reloads → AI screenshots the result → confirms the fix, in a single loop. The user just looks at the outcome.

**Context:**
The AI-with-a-browser story only matters when code edits and verification close the loop. MCP alone tends to be "AI looks at the browser"; pairing with the local dev server's auto-reload makes the loop close.

**Implementation direction:**
Not directly the MCP's job — the AI (Claude Code etc.) alternates between file edits and MCP screenshot calls. What MCP must provide: "wait for stable state after reload before returning the snapshot" (`networkidle`-style).

---

## 3. Tool inventory

| Tool | Purpose | Default behaviour |
|---|---|---|
| `listTabs` | All tabs: id / title / url / active | - |
| `getTabInfo(tabId)` | Lightweight metadata (favicon, opened-at, frame tree) | - |
| `screenshot(tabId, {fullPage?})` | Capture | Viewport only |
| `getPageText(tabId, {offset?})` | Visible text | First 2000 chars + truncated flag |
| `getInteractables(tabId, {viewport?})` | Clickable / typable nodes with role+label+stableId+coords | Visible viewport only |
| `getConsoleLogs(tabId, {since?, level?})` | Console logs | level:error / last 20 |
| `getNetworkActivity(tabId, {since?, failedOnly?})` | Request summary | failedOnly:true / last 20 |
| `getNetworkRequest(tabId, requestId)` | One request's headers/body | - |
| `getStorage(tabId, {types})` | cookie / localStorage / sessionStorage | - |
| `getSourceAt(tabId, url, line, {range?})` | JS source slice (sourcemap-resolved) | ±10 lines |
| `click(tabId, stableId)` | Click by stable ID; goes through safety check if risky | - |
| `type(tabId, stableId, text)` | Type into input | - |
| `scroll(tabId, {to or by})` | Scroll | - |
| `navigate(tabId, url)` | Same-tab navigation | - |
| `evalJs(tabId, expression)` | JS eval; subject to safety check | - |
| `waitForStable(tabId, {timeout?})` | Wait for networkidle | timeout 5s |
| `setSafetyMode(mode)` | always / dangerous-only / off | - |

---

## 4. Context-saving design

Without explicit design, the AI would "read the whole DOM in one shot." We want it to walk staged instead.

**① Tag tools with a Stage and surface that in the description**
listTabs (Stage 1) → screenshot/getPageText (Stage 2) → getInteractables (Stage 3) → getConsoleLogs/getNetworkActivity (Stage 4) → getSourceAt (Stage 5). Each description starts with `[Stage N]` and reminds the AI to pass filters.

**② Defaults are narrow; widening is opt-in**
Screenshot is viewport-only. Logs/Network are filtered + count-capped. `getPageText` returns a head slice + truncated flag. `getInteractables` is visible-only. "Give me everything" requires explicit args.

**③ Summary + handle pattern for drill-down**
`getNetworkActivity` returns `{total, failed, slow, items[top-N]}`. The detail per request is fetched separately via `getNetworkRequest(requestId)`. `getInteractables` returns only stable IDs and metadata, never raw HTML. The AI lands on a target with the summary and pulls the one detail it needs.

**④ Push the standard flow via MCP `instructions`**
On startup the server sends "listTabs → one visual tool → optional structure/drill-down, filters mandatory, evalJs is last resort" so the AI naturally takes the shortest path.

---

## 5. Out of scope

### Hard out
- Multiple Chrome profiles / switching user sessions
- Headless Chrome (this MCP is for the Chrome you're already using)
- Chrome Web Store listing (manual install via Developer Mode for now)

### Pending info
- Tuning rules for "dangerous" classification. Start heuristic; if false positives are loud, externalise the rules.
- Ring buffer sizes for network/console (memory vs round-trip token cost). Hardcode for now.

### Provisional values
- Screenshot DPR / compression: 1.5x / JPEG 80 by default. Bump if AI complains about legibility.

---

## 6. Definition of done

- All six experiences work against real sites (e.g. GitHub, Gmail, a local dev server).
- The extension running in the background does not cause perceptible browsing slowdown.
- The MCP server connects from both Claude Code and Claude Desktop.
- The confirmation overlay fires at least for `submit`-style buttons and money-shaped labels.
- README documents the manual install + the Claude config example.

---

## 7. Related docs

- (post-implementation) `docs/ARCHITECTURE.md` ── extension ↔ MCP protocol
- (post-implementation) `README.md` ── install + Claude config
- `/Users/rikuto/.claude/CLAUDE.md` ── pre-deploy local-verification rule
