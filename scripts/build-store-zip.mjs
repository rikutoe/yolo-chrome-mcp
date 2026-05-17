#!/usr/bin/env node
// Build the Chrome Web Store upload zip from extension/dist.
// Output: build/yolo-chrome-mcp-extension-store-v<version>.zip
import { execSync } from "node:child_process";
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "extension", "dist");
const OUT_DIR = join(ROOT, "build");

if (!existsSync(join(SRC, "manifest.json"))) {
  console.error("extension/dist/manifest.json not found — run `npm run build` first.");
  process.exit(1);
}

const manifest = JSON.parse(await readFile(join(SRC, "manifest.json"), "utf8"));
const version = manifest.version;
if (!version) {
  console.error("manifest.json has no version field.");
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `yolo-chrome-mcp-extension-store-v${version}.zip`);
await rm(outPath, { force: true });

// macOS / Linux ship `zip`. Use -r and exclude OS junk.
execSync(`zip -r "${outPath}" . -x ".DS_Store" "*/.DS_Store"`, {
  cwd: SRC,
  stdio: "inherit",
});

const size = execSync(`du -h "${outPath}" | cut -f1`).toString().trim();
console.log(`\n✓ Built ${outPath} (${size})`);
console.log(`  Upload this zip at https://chrome.google.com/webstore/devconsole/`);
