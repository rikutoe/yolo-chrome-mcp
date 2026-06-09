# CLAUDE.md

## Doc-driven
- On session start: read `docs/PROJECT.md` and the Current Phase before acting.
- On task completion or structural changes: call the `doc-driven` skill to sync docs.
- When you make a technical decision: append a one-liner to `docs/PROJECT.md` Decisions.

## Project-specific
- The WS protocol types are duplicated inline in `server/src/wire.ts` and `extension/src/wire.ts`. If you change one, change both.
- MV3 service worker keepalive uses `chrome.alarms` at 15s. Reconnect logic lives at the bottom of `extension/src/background.ts`.
- After rebuilding the extension, you must click the ↻ reload button on the extension's card in `chrome://extensions` — Chrome does not auto-pick up the new build.
- Adding a new tool:
  1. Define the zod schema + stage-tagged description in `server/src/tools.ts`
  2. Implement the handler in `extension/src/handlers.ts`
  3. Register it in the `handlers` table in `extension/src/background.ts`
  4. Add a case to `scripts/e2e.mjs`
- Version lives in several files (root/server/extension `package.json`, `extension/manifest.json`). The `.mcpb` bundle version is NOT one of them: `scripts/build-mcpb.mjs` injects the root `package.json` version into the manifest at build time, so the `version` field committed in `mcpb/manifest.json` is just a template and is ignored at build. Don't rely on bumping it; bump the root `package.json`.
- Distribution: pushing a `v*` tag fires `.github/workflows/release.yml`, which runs `npm publish` and creates a GitHub Release. Requires `NPM_TOKEN` in repo secrets.
