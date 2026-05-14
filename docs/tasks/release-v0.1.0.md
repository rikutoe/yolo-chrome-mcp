# Cut the first v0.1.0 release

## Goal
Reach a state where anyone can use the project with just:

```
claude mcp add yolo-chrome -- npx -y yolo-chrome-mcp@latest
npx yolo-chrome-mcp install
```

And, for Claude Desktop, download the `.mcpb` from the GitHub Release and drag it onto the app.

## Approach
Tag a release to fire `.github/workflows/release.yml`. The workflow:
1. Builds everything (`npm run build:all`)
2. Zips the Chrome extension
3. Runs `npm publish --provenance` (requires `NPM_TOKEN`)
4. Creates a GitHub Release and attaches `.mcpb` and the extension zip

## Steps
- [ ] Confirm there's an npm account and that the name `yolo-chrome-mcp` is available (`npm view yolo-chrome-mcp`)
- [ ] Generate an `NPM_TOKEN` (Automation token)
- [ ] Add `NPM_TOKEN` under GitHub repo Settings → Secrets and variables → Actions
- [ ] `git tag v0.1.0 && git push origin v0.1.0`
- [ ] Verify the publish succeeded in the Actions log
- [ ] Verify `npx yolo-chrome-mcp@0.1.0 --version` works from a fresh shell
- [ ] Verify the GitHub Release page has both `.mcpb` and the extension zip attached

## Notes
- If the name is taken, switch to the scoped name `@rikutoe/yolo-chrome-mcp` (also update README and `install.ts` examples).
- A scoped first publish needs `--access public`.
