// Run before `npm pack` / `npm publish`. Copies the built Chrome extension
// from ../extension/dist into ./extension so the published tarball is
// self-contained — `npx yolo-chrome-mcp install` can hand users a path
// without a second download step.
import { cp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const SRC = "../extension/dist";
const DST = "extension";

if (!existsSync(SRC)) {
  console.error(
    `prepack: ${SRC} not found. Run \`npm run build\` at the repo root first.`
  );
  process.exit(1);
}

await rm(DST, { recursive: true, force: true });
await cp(SRC, DST, { recursive: true });
const s = await stat(DST);
console.log(`prepack: copied extension -> ${DST} (${s.size}B dir entry)`);
