import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
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

const ROUTING_RULE_BLOCK_EN = `${ROUTING_HEADING}

**Default to \`WebSearch\` / \`WebFetch\`.** Use them for any research over public information (product comparisons, pricing, company info, news, reading docs). Don't reach for yolo-chrome-mcp for these — WebSearch is fast, parallelizable, and light on context, whereas yolo-chrome-mcp drives the UI one action at a time and is overkill for research.

**Use yolo-chrome-mcp (\`mcp__yolo-chrome__*\`) only when:**
1. The information or action requires driving the UI directly — a logged-in dashboard, a SPA where WebFetch returns empty, submitting a form, DOM manipulation, reading the console / network, etc.
2. The user explicitly asks you to "open it in the browser" / "do it in Chrome".

**For those UI cases, do not fall back to other browser tools:**
- \`mcp__Claude_in_Chrome__*\`
- \`mcp__Control_Chrome__*\`
- \`mcp__computer-use__*\` mouse/keyboard that drives a browser window

**If the extension is not connected:** if a yolo-chrome-mcp call returns \`not connected\`, do **not** switch to another browser tool. Tell the user to open \`chrome://extensions\`, enable \`yolo-chrome-mcp\`, and reload — then stop.

**Why:** yolo-chrome-mcp rides on the user's already-logged-in Chrome session, drives the page via the accessibility tree, and gates risky actions behind a local in-tab safety overlay. For plain public-info research, WebSearch / WebFetch are faster and lighter — pick the tool by purpose.
`;

const ROUTING_RULE_BLOCK_JA = `${ROUTING_HEADING}

**デフォルトは \`WebSearch\` / \`WebFetch\`。** 公開情報を集めるリサーチ（製品比較、料金調査、企業情報、ニュース、ドキュメント参照など）はこれで完結させる。yolo-chrome-mcp は使わない。WebSearch は速く、並列で叩け、コンテキストも軽い。yolo-chrome-mcp は 1 操作ずつ UI を介すので遅く、調査用途にはオーバーキル。

**yolo-chrome-mcp (\`mcp__yolo-chrome__*\`) を使うのは次の場合に限る**：
1. UI を直接叩かないと取得・操作できない情報（ログイン後の管理画面、WebFetch が空を返す SPA、フォーム送信が必要な処理、DOM 操作、コンソール/ネットワーク確認など）
2. ユーザーが明示的に「ブラウザで開いて」「Chrome で操作して」等と指示したとき

**上記の UI 用途では他のブラウザツールにフォールバックしない**（同じ目的で代替しない）：
- \`mcp__Claude_in_Chrome__*\`
- \`mcp__Control_Chrome__*\`
- \`mcp__computer-use__*\` のマウス/キーボードでブラウザを動かす操作

**未接続だったときの動作**: yolo-chrome-mcp が \`not connected\` を返したら、他のブラウザツールに切り替えず、ユーザーに「\`chrome://extensions\` で \`yolo-chrome-mcp\` を有効化してリロードしてください」と伝えて止まる。

**理由**: yolo-chrome-mcp はログイン済み Chrome セッションに直接乗り、accessibility-tree ベースで操作し、危険操作はローカルのセーフティオーバーレイで確認される。一方、単なる公開情報リサーチには WebSearch / WebFetch の方が速く軽い。用途で使い分ける。
`;

function isJapaneseLocale(): boolean {
  const env = process.env.YOLO_CHROME_LANG ?? process.env.LANG ?? process.env.LC_ALL ?? "";
  return /^ja(_|$)/i.test(env);
}

const ROUTING_RULE_BLOCK = isJapaneseLocale() ? ROUTING_RULE_BLOCK_JA : ROUTING_RULE_BLOCK_EN;

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

// ---------- claude CLI registration ----------

const CLAUDE_MCP_NAME = "yolo-chrome";
const CLAUDE_MCP_COMMAND = ["npx", "-y", "yolo-chrome-mcp@latest"];

function hasClaudeCli(): boolean {
  const probe = spawnSync(platform() === "win32" ? "where" : "which", ["claude"], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

function isAlreadyRegistered(): boolean {
  const probe = spawnSync("claude", ["mcp", "list"], { encoding: "utf8" });
  if (probe.status !== 0) return false;
  return new RegExp(`^${CLAUDE_MCP_NAME}:`, "m").test(probe.stdout ?? "");
}

type RegisterOutcome = "registered" | "already" | "no-cli" | "failed";

function registerWithClaude(): { outcome: RegisterOutcome; message: string } {
  if (!hasClaudeCli()) {
    return {
      outcome: "no-cli",
      message:
        `  • 'claude' CLI not found on PATH. Skipping auto-registration.\n` +
        `    Once Claude Code is installed, register manually with:\n\n` +
        `        claude mcp add --scope user ${CLAUDE_MCP_NAME} -- ${CLAUDE_MCP_COMMAND.join(" ")}\n`,
    };
  }
  if (isAlreadyRegistered()) {
    return {
      outcome: "already",
      message: `  ✓ '${CLAUDE_MCP_NAME}' is already registered with Claude Code (no change).\n`,
    };
  }
  const res = spawnSync(
    "claude",
    ["mcp", "add", "--scope", "user", CLAUDE_MCP_NAME, "--", ...CLAUDE_MCP_COMMAND],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
  );
  if (res.status !== 0) {
    return {
      outcome: "failed",
      message:
        `  ⚠ 'claude mcp add' exited with status ${res.status}.\n` +
        `    stderr: ${(res.stderr ?? "").trim() || "(empty)"}\n` +
        `    You can retry manually:\n\n` +
        `        claude mcp add --scope user ${CLAUDE_MCP_NAME} -- ${CLAUDE_MCP_COMMAND.join(" ")}\n`,
    };
  }
  return {
    outcome: "registered",
    message:
      `  ✓ Registered '${CLAUDE_MCP_NAME}' with Claude Code (--scope user).\n` +
      `    Command: ${CLAUDE_MCP_COMMAND.join(" ")}\n`,
  };
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
`);
  const reg = registerWithClaude();
  process.stdout.write(reg.message + "\n");
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
or unpacked). Registering the MCP server with Claude Code and wiring routing
so Claude always uses yolo-chrome-mcp for Chrome operations.

`);
  const reg = registerWithClaude();
  process.stdout.write(reg.message + "\n");
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
