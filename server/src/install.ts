import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { platform } from "node:os";

// Resolves the Chrome extension directory shipped inside this npm package.
function resolveExtensionDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // When installed via npm: <pkg>/dist/install.js → <pkg>/extension
  const npmPath = resolve(here, "..", "extension");
  if (existsSync(join(npmPath, "manifest.json"))) return npmPath;
  // When run from monorepo source: <repo>/server/dist/install.js → <repo>/extension/dist
  const repoPath = resolve(here, "..", "..", "extension", "dist");
  if (existsSync(join(repoPath, "manifest.json"))) return repoPath;
  throw new Error(
    "Could not locate the bundled Chrome extension. Did the package build correctly?"
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  const cmd =
    platform() === "darwin"
      ? "pbcopy"
      : platform() === "win32"
      ? "clip"
      : "xclip";
  try {
    const proc = spawn(cmd, platform() === "linux" ? ["-selection", "clipboard"] : [], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    proc.stdin.write(text);
    proc.stdin.end();
    await new Promise((r) => proc.on("close", r));
    return true;
  } catch {
    return false;
  }
}

function openUrl(url: string) {
  const cmd =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
      ? "start"
      : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Best-effort.
  }
}

export async function runInstall() {
  const dir = resolveExtensionDir();
  const clipboardOk = await copyToClipboard(dir);

  const node = process.execPath;
  const serverEntry = fileURLToPath(new URL("./index.js", import.meta.url));

  process.stdout.write(`
yolo-chrome-mcp — install helper

1. Load the Chrome extension
   • Opening chrome://extensions in your default browser now…
   • Toggle "Developer mode" (top-right).
   • Click "Load unpacked" → in the file dialog press Cmd/Ctrl+Shift+G,
     then Cmd/Ctrl+V to paste this path, then Select:

       ${dir}
${clipboardOk ? "       (already copied to clipboard)" : ""}

2. Register the server with Claude Code
   • Run:

       claude mcp add yolo-chrome -- npx -y yolo-chrome-mcp@latest

   • Or for a local checkout:

       claude mcp add yolo-chrome -- ${node} ${serverEntry}

3. Verify
   • Restart Claude Code. The Chrome extension's popup should show a green
     "MCPサーバに接続中" dot once Claude Code spawns the server.

`);
  openUrl("chrome://extensions");
}
