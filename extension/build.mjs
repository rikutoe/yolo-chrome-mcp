import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await build({
  entryPoints: {
    background: "src/background.ts",
    overlay: "src/overlay.ts",
    popup: "src/popup.ts",
  },
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: "dist",
  platform: "browser",
  sourcemap: false,
  logLevel: "info",
});

await cp("manifest.json", "dist/manifest.json");
await cp("popup.html", "dist/popup.html");
await cp("icons", "dist/icons", { recursive: true });
await cp("_locales", "dist/_locales", { recursive: true });

console.log("extension built -> extension/dist");
