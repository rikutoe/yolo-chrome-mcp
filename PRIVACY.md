# Privacy Policy — Yolo Chrome MCP for Claude

_Last updated: 2026-05-14_

This Chrome extension ("the Extension") exposes the contents of the
Chrome tab it is currently observing to an MCP (Model Context Protocol)
server running on the same computer, so that an AI assistant (typically
Claude Code or Claude Desktop) can read and operate the page.

This page explains exactly what data the Extension touches, where it
goes, and what it does **not** do.

## What the Extension can access

When you ask Claude to operate a tab, the Extension uses the standard
Chrome extension permissions (`tabs`, `debugger`, `scripting`, `cookies`,
`storage`, `alarms`) and the Chrome DevTools Protocol to:

- list open tabs and basic metadata (title, URL, status)
- take screenshots of a tab
- read visible page text and the accessibility tree
- read console messages and network activity buffered by the page
- read cookies for the active page when Claude requests them
- click, type, scroll, and navigate when Claude requests it
- evaluate JavaScript expressions in a page when Claude requests it

The Extension does this **only on tabs that the AI explicitly references
by tab id**. Tabs the AI never asks about are not read.

## Where the data goes

The Extension talks **only** to a local WebSocket server running at
`ws://127.0.0.1:8765` (or a port you configure) on your own computer.
That server is the `yolo-chrome-mcp` MCP server you installed via npm or
Claude Desktop. The Extension does not make any network requests to any
third-party server.

What the local MCP server does with that data is determined by Claude
Code / Claude Desktop, which is the parent process:

- Claude Code / Desktop forwards the data to Anthropic's API as part of
  the conversation context, subject to
  [Anthropic's privacy policy](https://www.anthropic.com/privacy).
- The MCP server itself does not log, persist, or transmit data anywhere
  else.

## What the Extension stores locally

The Extension stores a single preference in `chrome.storage.local`:

- `safetyMode`: one of `always`, `dangerous-only`, `off` — controls when
  the in-tab safety overlay asks for confirmation before a destructive
  action.

That's it. No browsing history, no page contents, no credentials are
persisted by the Extension.

## What the Extension does not do

- It does not send any data to any third-party analytics or telemetry
  service.
- It does not read tabs in the background without an explicit request
  from the MCP server.
- It does not transmit data over any network other than the local
  loopback connection to the MCP server.
- It does not modify, share, or sell your data.

## Sensitive actions

The Extension ships with an in-tab "safety overlay" that asks for
confirmation before potentially-sensitive actions (money labels,
account-destructive labels, password-form submits, credit-card / password
typing, risky `evalJs`). You can adjust this in the Extension popup.

The companion `yolo-chrome-mcp` CLI also installs a PreToolUse hook in
Claude Code that prevents Claude from silently switching to other browser
tools that bypass the safety overlay.

## Contact

Source code: [github.com/rikutoe/yolo-chrome-mcp](https://github.com/rikutoe/yolo-chrome-mcp)

For questions about this policy, file an issue on the repository or
email `rikuto@seedx.tech`.
