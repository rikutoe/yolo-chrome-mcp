# Verifying the new-user install flow

Re-running the installer on your own machine proves nothing — it detects the
existing setup and prints "already / no change". To confirm a brand-new user
can follow the steps and end up working, test from a **blank slate**.

Assumed prerequisite: Node.js is installed. (We don't test the no-Node case.)

There are two halves. The command half is automated; the extension half is a
quick manual check.

---

## Half 1 — Command (automated)

Points `HOME` at a throwaway temp dir so the installer writes everything from
scratch, then asserts the four artifacts a new user needs were created
correctly, plus idempotency on re-run.

```bash
npm run verify:install
```

Tests the **local build** (run this before publishing). To instead test the
**published** package — exactly what a new user downloads:

```bash
YOLO_VERIFY_TARGET=npx node scripts/verify-fresh-install.mjs
```

Checks performed (see `scripts/verify-fresh-install.mjs`):

| # | Check | Artifact |
|---|-------|----------|
| 1 | MCP server registered with Claude Code | `~/.claude.json` |
| 2 | PreToolUse routing hook present (exactly one) | `~/.claude/settings.json` |
| 3 | Routing rule appended | `~/.claude/CLAUDE.md` |
| 4 | Hook script exists and is executable | `~/.yolo-chrome-mcp/browser-routing-hook.sh` |
| 5 | Canonical rule file dropped | `~/.yolo-chrome-mcp/routing-rule.md` |
| 6 | Re-run does not duplicate the hook | (idempotency) |

Exit code 0 = pass. Check 1 is skipped automatically if the `claude` CLI is not
on PATH (e.g. on CI), so the rest still run.

---

## Half 2 — Extension + connection (manual)

The browser half can't be asserted headlessly. Use a **throwaway Chrome
profile** so your already-installed extension doesn't interfere:

```bash
# macOS example — fresh profile, no existing extensions
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir=/tmp/yolo-fresh-profile
```

Then walk the literal store steps:

- [ ] Install the extension (Web Store "Add to Chrome", or Load unpacked
      `extension/dist` via `chrome://extensions` → Developer mode).
- [ ] Run `npx -y yolo-chrome-mcp@latest install --routing-only` (or the
      command the popup's Copy button shows).
- [ ] Restart Claude Code / Claude Desktop.
- [ ] Click the extension icon — the status dot turns **green** (connected).
- [ ] Ask Claude "screenshot this tab" — it uses `mcp__yolo-chrome__*` tools
      and returns an image.

If the dot stays red: open `chrome://extensions`, confirm the extension is
enabled, and reload it.

When done, delete the throwaway profile: `rm -rf /tmp/yolo-fresh-profile`.
