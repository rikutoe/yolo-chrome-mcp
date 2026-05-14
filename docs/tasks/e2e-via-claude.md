# Run the full 17-tool E2E via Claude Code

## Goal
Drive the MCP from Rikuto's Claude Code against a real session and cover what `scripts/e2e.mjs` left unverified:
- `click` / `type` (via accessibility-tree stableId)
- `navigate` + `waitForStable` chained
- `getTabInfo` on an attachable tab
- `getSourceAt` / `getNetworkRequest`
- Safety overlay firing for risky labels

## Approach
After releasing, run `claude mcp add` and have Claude perform a real task ("open example.com in a new tab and fill the form"); observe the resulting behaviour.

## Steps
- [ ] release-v0.1.0 finished
- [ ] `claude mcp add yolo-chrome -- npx -y yolo-chrome-mcp@latest`
- [ ] Open a test page (e.g. httpbin.org/forms/post)
- [ ] Ask Claude: listTabs → getInteractables → type → click submit, and confirm the overlay fires
- [ ] Ask Claude to perform a cross-origin navigate and confirm the overlay fires
- [ ] Record any bugs/fix-ups in `docs/PROJECT.md` Decisions, or spin them into the next task

## Notes
- For each failure mode found, add a case to `scripts/e2e.mjs` so it stays covered going forward.
