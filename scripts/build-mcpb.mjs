#!/usr/bin/env node
// Build a Claude Desktop / MCPB bundle (.mcpb = zip with manifest.json at root).
// Layout inside the zip:
//   manifest.json
//   server/dist/*           (built MCP server)
//   server/node_modules/*   (production-only deps, flattened)
//   extension/*             (built Chrome extension, bundled for convenience)
import { execSync } from "node:child_process";
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const STAGE = join(ROOT, "build", "mcpb-stage");
const OUT_DIR = join(ROOT, "build");

// Always start clean.
await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });
await mkdir(OUT_DIR, { recursive: true });

// 1. manifest.json — inject the canonical version from the root package.json so
// the bundle can never ship a stale version (the committed mcpb/manifest.json
// version is intentionally not trusted here; it's only a template).
const rootPkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const mcpbManifest = JSON.parse(
  await readFile(join(ROOT, "mcpb", "manifest.json"), "utf8")
);
mcpbManifest.version = rootPkg.version;
await writeFile(
  join(STAGE, "manifest.json"),
  JSON.stringify(mcpbManifest, null, 2) + "\n"
);

// 2. server build output
if (!existsSync(join(ROOT, "server", "dist", "index.js"))) {
  console.error("server/dist not found — run `npm run build` first.");
  process.exit(1);
}
await mkdir(join(STAGE, "server", "dist"), { recursive: true });
await cp(join(ROOT, "server", "dist"), join(STAGE, "server", "dist"), {
  recursive: true,
});
await cp(join(ROOT, "server", "package.json"), join(STAGE, "server", "package.json"));

// 3. production node_modules for the server
console.log("Installing production deps into stage…");
execSync("npm install --omit=dev --no-audit --no-fund --no-package-lock", {
  cwd: join(STAGE, "server"),
  stdio: "inherit",
});

// 4. extension (built)
if (existsSync(join(ROOT, "extension", "dist", "manifest.json"))) {
  await cp(join(ROOT, "extension", "dist"), join(STAGE, "extension"), {
    recursive: true,
  });
}

// 5. README pointer
await writeFile(
  join(STAGE, "README.md"),
  `# yolo-chrome-mcp\n\nLoad the Chrome extension at \`extension/\` (chrome://extensions → Load unpacked).\nSee https://github.com/seedx-tech/yolo-chrome-mcp.\n`
);

// 6. Read version, then zip.
const manifest = JSON.parse(
  await readFile(join(STAGE, "manifest.json"), "utf8")
);
const outFile = join(OUT_DIR, `yolo-chrome-mcp-${manifest.version}.mcpb`);
await rm(outFile, { force: true });

console.log(`Zipping → ${outFile}`);
execSync(`cd ${JSON.stringify(STAGE)} && zip -r ${JSON.stringify(outFile)} . -x ".*"`, {
  stdio: "inherit",
  shell: "/bin/bash",
});

console.log(`\nBuilt ${outFile}`);
console.log(`Drag this file onto Claude Desktop to install.`);
