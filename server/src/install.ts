import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { platform, homedir } from "node:os";
import { createInterface } from "node:readline/promises";

// ---------- constants ----------

// Chrome Web Store URL. Empty until the listing is approved — the install
// helper then falls back to "Load unpacked". Once the listing is live, set
// this to the canonical https://chromewebstore.google.com/... link so users
// get the one-click flow.
const CHROME_WEB_STORE_URL = process.env.YOLO_CHROME_WEB_STORE_URL ?? "";

// ---------- paths ----------

const HOME = homedir();
const CLAUDE_DIR = join(HOME, ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const CLAUDE_MD_PATH = join(CLAUDE_DIR, "CLAUDE.md");
const YOLO_DIR = join(HOME, ".yolo-chrome-mcp");
const HOOK_SCRIPT_PATH = join(YOLO_DIR, "browser-routing-hook.sh");

const ROUTING_HEADING = "## Browser routing (yolo-chrome-mcp)";

const ROUTING_RULE_BLOCK = `${ROUTING_HEADING}

Chrome を操作するとき（URL を開く、クリック、タイプ、スクリーンショット、コンソール/ネットワーク取得、ページ内 JS 実行など）は **必ず yolo-chrome-mcp (\`mcp__yolo-chrome__*\`) を使う**。

**使ってはいけないツール**（同じ目的で他のブラウザツールにフォールバックしない）：
- \`mcp__Claude_in_Chrome__*\`
- \`mcp__Control_Chrome__*\`
- \`mcp__computer-use__*\` のマウス/キーボードでブラウザを動かす操作
- \`WebFetch\`（ログイン不要の素の静的ページで yolo-chrome-mcp が使えないときの最終手段に限る）

**未接続だったときの動作**: \`not connected\` エラーが出たら、他のツールに切り替えず、ユーザーに「\`chrome://extensions\` で \`yolo-chrome-mcp\` を有効化してリロードしてください」と伝えて止まる。**勝手に他のブラウザツールに切り替えない**。

**理由**: yolo-chrome-mcp はログイン済み Chrome セッションに直接乗り、accessibility-tree ベースで操作し、危険操作はローカルのセーフティオーバーレイで確認される。他のツールは別認証が必要だったり、セーフティオーバーレイをバイパスする。
`;

const HOOK_SCRIPT = `#!/usr/bin/env bash
# yolo-chrome-mcp PreToolUse hook.
# Intercepts attempts to use competing browser tools and tells Claude to use
# yolo-chrome-mcp instead. If the routing rule is not yet in ~/.claude/CLAUDE.md,
# also instructs Claude to offer adding it via AskUserQuestion.

set -euo pipefail

CLAUDE_MD="$HOME/.claude/CLAUDE.md"
HAS_RULE=no
if [ -f "$CLAUDE_MD" ] && grep -q "^## Browser routing (yolo-chrome-mcp)" "$CLAUDE_MD" 2>/dev/null; then
  HAS_RULE=yes
fi

if [ "$HAS_RULE" = "yes" ]; then
  reason="Use the yolo-chrome-mcp tools (mcp__yolo-chrome__navigate, click, type, screenshot, etc.) instead. Your ~/.claude/CLAUDE.md has a Browser routing rule that forbids using this tool for Chrome operations. If yolo-chrome-mcp returns 'not connected', ask the user to enable the extension at chrome://extensions and reload — do not fall back to other browser tools."
else
  reason="Use the yolo-chrome-mcp tools (mcp__yolo-chrome__navigate, click, type, screenshot, etc.) instead of this tool for Chrome operations. Also: ~/.claude/CLAUDE.md does not yet contain a Browser routing rule. Before retrying, use AskUserQuestion to offer adding the rule now (options: A) add the rule, B) skip). If A, append the standard Browser routing block to ~/.claude/CLAUDE.md (you can find the canonical block in $HOME/.yolo-chrome-mcp/routing-rule.md). If B, run: mkdir -p ~/.yolo-chrome-mcp && touch ~/.yolo-chrome-mcp/routing_declined."
fi

# Emit blocking decision as JSON on stdout.
python3 -c '
import json, sys
print(json.dumps({"decision": "block", "reason": sys.argv[1]}))
' "$reason"
`;

// ---------- helpers ----------

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

function resolveExtensionDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const npmPath = resolve(here, "..", "extension");
  if (existsSync(join(npmPath, "manifest.json"))) return npmPath;
  const repoPath = resolve(here, "..", "..", "extension", "dist");
  if (existsSync(join(repoPath, "manifest.json"))) return repoPath;
  throw new Error(
    "Could not locate the bundled Chrome extension. Did the package build correctly?"
  );
}

async function prompt(rl: ReturnType<typeof createInterface>, q: string, defYes = true): Promise<boolean> {
  const suffix = defYes ? " [Y/n] " : " [y/N] ";
  try {
    const ans = (await rl.question(q + suffix)).trim().toLowerCase();
    if (ans === "") return defYes;
    return ans.startsWith("y");
  } catch (err: any) {
    // stdin closed (e.g. piped input ran out) — fall back to default.
    if (err?.code === "ERR_USE_AFTER_CLOSE" || err?.code === "ABORT_ERR") {
      process.stdout.write(`\n  (no input — using default: ${defYes ? "yes" : "no"})\n`);
      return defYes;
    }
    throw err;
  }
}

// ---------- routing rule (CLAUDE.md) ----------

async function ensureRoutingRule(): Promise<"added" | "already" | "created"> {
  let content = "";
  let existed = false;
  try {
    content = await readFile(CLAUDE_MD_PATH, "utf8");
    existed = true;
  } catch {
    // file missing — we will create it
  }
  if (content.includes(ROUTING_HEADING)) return "already";
  const sep = content && !content.endsWith("\n") ? "\n\n" : content ? "\n" : "";
  await mkdir(CLAUDE_DIR, { recursive: true });
  await writeFile(CLAUDE_MD_PATH, content + sep + ROUTING_RULE_BLOCK, "utf8");
  return existed ? "added" : "created";
}

// ---------- PreToolUse hook (settings.json) ----------

const HOOK_MATCHER = "mcp__Claude_in_Chrome__.*|mcp__Control_Chrome__.*";

async function writeHookScript(): Promise<void> {
  await mkdir(YOLO_DIR, { recursive: true });
  await writeFile(HOOK_SCRIPT_PATH, HOOK_SCRIPT, "utf8");
  await chmod(HOOK_SCRIPT_PATH, 0o755);
  // Also drop the canonical routing-rule block where the hook can point users to.
  await writeFile(join(YOLO_DIR, "routing-rule.md"), ROUTING_RULE_BLOCK, "utf8");
}

type SettingsShape = {
  hooks?: {
    PreToolUse?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

async function ensureHook(): Promise<"added" | "already" | "updated"> {
  let settings: SettingsShape = {};
  let existed = false;
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    settings = JSON.parse(raw);
    existed = true;
  } catch {
    // missing or malformed — start fresh
  }

  settings.hooks = settings.hooks ?? {};
  const list = (settings.hooks.PreToolUse = settings.hooks.PreToolUse ?? []);

  // Look for an existing entry that already targets our matcher.
  const existingIdx = list.findIndex((e) => e.matcher === HOOK_MATCHER);
  const desired = {
    matcher: HOOK_MATCHER,
    hooks: [{ type: "command", command: HOOK_SCRIPT_PATH }],
  };
  let outcome: "added" | "already" | "updated";
  if (existingIdx < 0) {
    list.push(desired);
    outcome = existed ? "added" : "added";
  } else {
    const same =
      JSON.stringify(list[existingIdx]) === JSON.stringify(desired);
    if (same) return "already";
    list[existingIdx] = desired;
    outcome = "updated";
  }

  await mkdir(CLAUDE_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return outcome;
}

// ---------- entry points ----------

export type InstallOptions = {
  /** Skip extension load + `claude mcp add` reminder. For users who installed
   *  the extension from the Chrome Web Store and already ran `claude mcp add`
   *  (typically chained inline from the popup's copy-paste one-liner). */
  routingOnly?: boolean;
};

export async function runInstall(opts: InstallOptions = {}) {
  if (opts.routingOnly) {
    await runRoutingOnly();
    return;
  }
  const dir = resolveExtensionDir();
  const clipboardOk = await copyToClipboard(dir);
  const node = process.execPath;
  const serverEntry = fileURLToPath(new URL("./index.js", import.meta.url));

  const useStore = CHROME_WEB_STORE_URL.length > 0;
  const step1 = useStore
    ? `Step 1. Install the Chrome extension
------------------------------------
  • Opening the Chrome Web Store listing in your default browser now…
  • Click "Add to Chrome" and confirm.

      ${CHROME_WEB_STORE_URL}

  (If you prefer a local / dev build, run with YOLO_CHROME_WEB_STORE_URL=""
  to fall back to "Load unpacked" instructions for ${dir}.)
`
    : `Step 1. Load the Chrome extension (unpacked, dev mode)
------------------------------------------------------
  • Opening chrome://extensions in your default browser now…
  • Toggle "Developer mode" (top-right).
  • Click "Load unpacked" → in the file dialog press Cmd/Ctrl+Shift+G,
    then Cmd/Ctrl+V to paste this path, then Select:

      ${dir}
${clipboardOk ? "      (already copied to clipboard)" : ""}

  (Once the Chrome Web Store listing is approved, this step becomes a
  one-click "Add to Chrome" install.)
`;

  process.stdout.write(`
yolo-chrome-mcp — install helper
================================

${step1}

Step 2. Register the server with Claude Code
--------------------------------------------
  • Run (once). Use --scope user so the server is available in every
    project, not just the directory you ran the command from:

      claude mcp add --scope user yolo-chrome -- npx -y yolo-chrome-mcp@latest

    Or for a local checkout:

      claude mcp add --scope user yolo-chrome -- ${node} ${serverEntry}

    Without --scope user, the server is only registered for the current
    project — Claude in other directories will report "Failed to connect".

`);
  openUrl(useStore ? CHROME_WEB_STORE_URL : "chrome://extensions");

  // Step 3 — interactive routing setup.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`Step 3. Browser routing (recommended)
-------------------------------------
Two pieces work together to make Claude always use yolo-chrome-mcp for
Chrome operations, instead of falling back to Claude_in_Chrome / Control_Chrome:

  (a) PreToolUse hook in ~/.claude/settings.json — blocks the wrong tools
      at runtime and tells Claude to use yolo-chrome-mcp.
  (b) Routing rule appended to ~/.claude/CLAUDE.md — gives Claude a
      persistent reason in plain language.

`);

    const installHook = await prompt(rl, "Install the PreToolUse hook?", true);
    if (installHook) {
      await writeHookScript();
      const r = await ensureHook();
      const msg =
        r === "already"
          ? "  ✓ Hook was already present in settings.json (no change)."
          : r === "updated"
          ? "  ✓ Hook updated in settings.json."
          : "  ✓ Hook added to settings.json.";
      process.stdout.write(msg + "\n");
      process.stdout.write(`    script: ${HOOK_SCRIPT_PATH}\n\n`);
    } else {
      process.stdout.write("  Skipped hook installation.\n\n");
    }

    const installRule = await prompt(rl, "Add routing rule to ~/.claude/CLAUDE.md?", true);
    if (installRule) {
      const r = await ensureRoutingRule();
      const msg =
        r === "already"
          ? "  ✓ Rule was already present in CLAUDE.md (no change)."
          : r === "created"
          ? "  ✓ Created ~/.claude/CLAUDE.md with the routing rule."
          : "  ✓ Appended routing rule to ~/.claude/CLAUDE.md.";
      process.stdout.write(msg + "\n\n");
    } else {
      process.stdout.write("  Skipped CLAUDE.md edit.\n\n");
    }
  } finally {
    rl.close();
  }

  process.stdout.write(`Step 4. Verify
--------------
  • Restart Claude Code. The extension popup should show a green
    "接続中" dot once Claude Code spawns the server.
  • Ask Claude to "open a Chrome tab" — it should use the
    mcp__yolo-chrome__* tools.

To remove the routing wiring later:

      npx yolo-chrome-mcp uninstall-routing

`);
}

async function runRoutingOnly() {
  process.stdout.write(`
yolo-chrome-mcp — routing setup
===============================

Assuming the Chrome extension is already installed (from the Chrome Web Store
or unpacked) and that you ran:

    claude mcp add --scope user yolo-chrome -- npx -y yolo-chrome-mcp@latest

Now wiring up Claude so it always uses yolo-chrome-mcp for Chrome operations.

`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const installHook = await prompt(rl, "Install the PreToolUse hook?", true);
    if (installHook) {
      await writeHookScript();
      const r = await ensureHook();
      const msg =
        r === "already"
          ? "  ✓ Hook was already present in settings.json (no change)."
          : r === "updated"
          ? "  ✓ Hook updated in settings.json."
          : "  ✓ Hook added to settings.json.";
      process.stdout.write(msg + "\n");
      process.stdout.write(`    script: ${HOOK_SCRIPT_PATH}\n\n`);
    } else {
      process.stdout.write("  Skipped hook installation.\n\n");
    }

    const installRule = await prompt(rl, "Add routing rule to ~/.claude/CLAUDE.md?", true);
    if (installRule) {
      const r = await ensureRoutingRule();
      const msg =
        r === "already"
          ? "  ✓ Rule was already present in CLAUDE.md (no change)."
          : r === "created"
          ? "  ✓ Created ~/.claude/CLAUDE.md with the routing rule."
          : "  ✓ Appended routing rule to ~/.claude/CLAUDE.md.";
      process.stdout.write(msg + "\n\n");
    } else {
      process.stdout.write("  Skipped CLAUDE.md edit.\n\n");
    }
  } finally {
    rl.close();
  }

  process.stdout.write(`Done. Restart Claude Code; the extension popup should turn green.
If it stays red, open chrome://extensions and make sure the extension is enabled.
To remove the routing wiring later: npx yolo-chrome-mcp uninstall-routing
`);
}

export async function runUninstallRouting() {
  // Remove the hook entry and the routing rule from CLAUDE.md.
  let touched = false;

  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const settings: SettingsShape = JSON.parse(raw);
    const list = settings.hooks?.PreToolUse;
    if (Array.isArray(list)) {
      const before = list.length;
      const filtered = list.filter((e) => e.matcher !== HOOK_MATCHER);
      if (filtered.length !== before) {
        settings.hooks!.PreToolUse = filtered;
        if (filtered.length === 0) delete (settings.hooks as any).PreToolUse;
        await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");
        process.stdout.write("  ✓ Removed PreToolUse hook from settings.json.\n");
        touched = true;
      }
    }
  } catch {
    // no settings.json; nothing to do
  }

  try {
    const md = await readFile(CLAUDE_MD_PATH, "utf8");
    const idx = md.indexOf(ROUTING_HEADING);
    if (idx >= 0) {
      // Remove from the heading to the next "## " or EOF.
      const tail = md.slice(idx);
      const nextHeading = tail.search(/\n## (?!Browser routing)/);
      const endIdx = nextHeading < 0 ? md.length : idx + nextHeading;
      const cleaned = (md.slice(0, idx) + md.slice(endIdx)).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
      await writeFile(CLAUDE_MD_PATH, cleaned, "utf8");
      process.stdout.write("  ✓ Removed routing rule from ~/.claude/CLAUDE.md.\n");
      touched = true;
    }
  } catch {
    // no CLAUDE.md; nothing to do
  }

  if (!touched) {
    process.stdout.write("Nothing to remove. Routing wiring is not installed.\n");
  }
}
