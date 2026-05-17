# Web Component click reliability

## Goal
`click` (and therefore `clickByLabel`) reliably dirties the form state on Polymer / lit-element pages — concretely, the YouTube Studio monetization editor's "Submit → Save" flow must work end-to-end through `mcp__yolo-chrome__*` without falling back to `evalJs(element.click())`.

### Done conditions

1. On a YouTube Studio video monetization page (`https://studio.youtube.com/video/{ID}/monetization/ads`):
   - clicking the Monetization dropdown chevron expands it
   - clicking the "On" radio + "Next" + "None of the above" checkbox + "Submit" leaves the editor's `Monetization` field on "On" (not silently reverted to "Off")
   - the "Save" button (`ytcp-button[label="Save"]`) becomes `disabled: false`
2. Verified by `getInteractables({labelMatch: "Save"})` returning a node with `disabled` absent (i.e. enabled).
3. The `mouseMoved` 5s-hang regression does NOT come back. If a new prepended event is added, it stays under ~50ms per click on the bench (`node scripts/bench-flow.mjs` — `click card-N` step).

## Background

See [yolo-chrome-mcp-youtube-monetization-session.md] (in Rikuto's Downloads, summarized in PROJECT.md D18). The failure mode:

> Click "On" radio → visually selected. Click "Next" → modal opens. Click "None of the above" → modal closes. But the editor's `Monetization` field stays "Off" and the Save button stays disabled. The visible click registered, but the framework's `change`/dirty bookkeeping never fired.

We tried prepending a `mouseMoved` CDP event before press/release. That **caused a 5-second hang per click** on the bench (`click card-164: 5012ms`). Reverted in commit 8f10338. Root cause TBD — possibly a chrome.debugger or Chrome bug with `Input.dispatchMouseEvent {type:"mouseMoved", button:"none", buttons:0}` on heavy pages.

So the obvious "mouseMoved first" trick is off the table without more investigation.

## Approach

Add a `clickStrategy` parameter to `click` and `clickByLabel` with three modes:

| value | what it does | when it fits |
|---|---|---|
| `"events"` (default) | current behavior: `Input.dispatchMouseEvent` press + release | vanilla HTML, React, Vue, most pages |
| `"native"` | call `element.click()` via `DOM.resolveNode` + `Runtime.callFunctionOn` | Web Component / Polymer pages where dispatch-based clicks don't dirty the form |
| `"events+native"` | both, in sequence (events first, then native as a backstop) | unknown / mixed |

Rationale: `element.click()` produces `isTrusted: false` events, which some frameworks filter out — that's why we don't make it the default. But Polymer's internal "active state" listeners typically respond to it, so on YouTube-Studio-class apps it's the right move.

Before adding the parameter, **investigate the 5s mouseMoved hang** so we can document or fix it. If it turns out to be safe under specific conditions, prefer reviving `mouseMoved` to adding `clickStrategy` (the latter pushes complexity onto the caller).

## Steps

- [ ] **B1 — Investigate mouseMoved 5s hang**
  - [ ] Build a minimal repro: navigate to `data:text/html,<button>x</button>`, prepend mouseMoved (button: "none", buttons: 0) before press/release, measure
  - [ ] Try variants: `button:"left"` + `buttons:0`; omit `button` entirely; use `type:"mouseMove"` (note: spelling — CDP uses `mouseMoved`)
  - [ ] Compare against a busy page (the bench's 200-card injection)
  - [ ] Decide: does mouseMoved work with the right params? Or is it fundamentally broken under chrome.debugger?
- [ ] **B2 — Implement clickStrategy**
  - [ ] Add `clickStrategy?: "events" | "native" | "events+native"` to the `click` and `clickByLabel` tools in [server/src/tools.ts](../../server/src/tools.ts) and [extension/src/handlers.ts](../../extension/src/handlers.ts)
  - [ ] In handlers.ts, add a `nativeClick(tabId, backendNodeId)` helper that does `DOM.resolveNode` → `Runtime.callFunctionOn` with `functionDeclaration: "function(){ this.click(); }"`
  - [ ] When `clickStrategy === "native"` skip the mouse-event dispatch and call `nativeClick` only
  - [ ] When `clickStrategy === "events+native"` do both
  - [ ] Update tool descriptions: "On Web Component pages (YouTube Studio, Google Cloud Console, Workspace Admin) where a dispatch-based click visually selects but doesn't dirty the form, retry with `clickStrategy: \"native\"`."
- [ ] **B3 — Verify on YouTube Studio**
  - [ ] Open `https://studio.youtube.com/video/{any-monetized-channel-video}/monetization/ads`
  - [ ] Drive: chevron click (`clickByLabel "Edit video monetization status"`) → On radio (`clickByLabel "On" roleMatch:"radio"`) → Next → None of the above → Submit
  - [ ] Re-fetch Save button via `getInteractables({labelMatch: "Save"})`. **Pass = `disabled` flag absent**. Fail = still `disabled: true` → try `clickStrategy: "native"` and re-run.
  - [ ] Take a screenshot of the editor showing Monetization: On + Save enabled, attach to the PR

## Notes

- The bench already exercises clicks on the injected DOM. After adding `clickStrategy`, extend [scripts/bench-flow.mjs](../../scripts/bench-flow.mjs) with a small scenario that asserts both strategies still work and stay under the per-click budget (~50ms).
- Files to look at first:
  - [extension/src/handlers.ts](../../extension/src/handlers.ts) — `click`, `clickByLabel`, `dispatchClick`
  - [server/src/tools.ts](../../server/src/tools.ts) — schema for click / clickByLabel
  - [docs/PROJECT.md](../PROJECT.md) D18 — current state of dispatchClick (press + release only)
- Don't bring `mouseMoved` back without first checking B1's findings against the bench's `click card-N` step. A 5s regression is more painful than the YouTube Studio bug it tries to fix.
- The YouTube Studio test requires a logged-in account with at least one Not-monetized video. Rikuto has us_tech (channel `UC-NY8yp4HlkZxJnMkynifxQ`) — but **don't actually toggle monetization on a real video without his go-ahead**. Use the dropdown-expand and the modal flow up to "Submit", then verify Save enablement. Submitting the Save itself is the one step that needs explicit approval.

## Starting point for the next conversation

> Read this file + the YouTube session log mentioned above. Start with **B1**: write the minimal mouseMoved repro and measure. Report what you found before touching anything in handlers.ts.
