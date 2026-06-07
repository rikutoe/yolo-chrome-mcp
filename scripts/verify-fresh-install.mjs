#!/usr/bin/env node
// Verify the new-user `install --routing-only` flow from a blank slate.
//
// Why: re-running the installer on a machine that already has it set up only
// prints "already / no change" — it proves nothing. This script points HOME at
// a throwaway temp dir so the installer writes everything from scratch, then
// asserts that the four artifacts a new user needs were created correctly:
//   1. MCP server registered with Claude Code   (~/.claude.json)
//   2. PreToolUse routing hook                   (~/.claude/settings.json)
//   3. Routing rule                              (~/.claude/CLAUDE.md)
//   4. Executable hook script + rule file        (~/.yolo-chrome-mcp/)
// It also runs the installer twice to confirm idempotency (no duplicate hook).
//
// This covers the COMMAND half of the new-user steps. The extension half
// (load in Chrome, green dot, WebSocket connect) is GUI and lives in
// docs/INSTALL_VERIFY.md as a manual checklist.
//
// Target:
//   default            test the local build (server/dist/index.js) — run before publishing
//   YOLO_VERIFY_TARGET=npx   test the published `yolo-chrome-mcp@latest` — what a user gets
//
// Exit code 0 = all checks passed, non-zero = a check failed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_MATCHER = "mcp__Claude_in_Chrome__.*|mcp__Control_Chrome__.*";
const ROUTING_HEADING = "## Browser routing (yolo-chrome-mcp)";

const useNpx = process.env.YOLO_VERIFY_TARGET === "npx";
const localEntry = join(__dirname, "..", "server", "dist", "index.js");
if (!useNpx && !existsSync(localEntry)) {
  console.error(`✗ ${localEntry} not found. Run \`npm run build:server\` first,`);
  console.error(`  or set YOLO_VERIFY_TARGET=npx to test the published package.`);
  process.exit(2);
}

const claudePresent = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], {
  stdio: "ignore",
}).status === 0;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

function runInstall(home) {
  const cmd = useNpx ? "npx" : process.execPath;
  const args = useNpx
    ? ["-y", "yolo-chrome-mcp@latest", "install", "--routing-only"]
    : [localEntry, "install", "--routing-only"];
  return spawnSync(cmd, args, {
    input: "y\ny\n", // hook? yes / rule? yes
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
    timeout: 120_000,
  });
}

const home = mkdtempSync(join(tmpdir(), "yolo-verify-"));
console.log(`Fresh HOME: ${home}`);
console.log(`Target: ${useNpx ? "npx yolo-chrome-mcp@latest" : "local build"}`);
console.log(`claude CLI: ${claudePresent ? "present" : "absent (MCP-registration check skipped)"}\n`);

try {
  const run1 = runInstall(home);
  if (run1.status !== 0) {
    console.error("✗ installer exited non-zero:\n" + (run1.stderr || run1.stdout || ""));
    process.exit(1);
  }

  const settingsPath = join(home, ".claude", "settings.json");
  const claudeMdPath = join(home, ".claude", "CLAUDE.md");
  const hookScript = join(home, ".yolo-chrome-mcp", "browser-routing-hook.sh");
  const ruleFile = join(home, ".yolo-chrome-mcp", "routing-rule.md");
  const claudeJson = join(home, ".claude.json");

  // 1. MCP registration (only assertable when the claude CLI is available)
  if (claudePresent) {
    const ok = existsSync(claudeJson) && readFileSync(claudeJson, "utf8").includes('"yolo-chrome"');
    check("MCP server registered (.claude.json)", ok);
  }

  // 2. PreToolUse hook
  let hookCount = 0;
  try {
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    const list = s.hooks?.PreToolUse ?? [];
    hookCount = list.filter((e) => e.matcher === HOOK_MATCHER).length;
    const entry = list.find((e) => e.matcher === HOOK_MATCHER);
    check("PreToolUse hook in settings.json", hookCount === 1 && !!entry?.hooks?.[0]?.command);
  } catch (e) {
    check("PreToolUse hook in settings.json", false, String(e.message));
  }

  // 3. Routing rule
  check(
    "Routing rule in CLAUDE.md",
    existsSync(claudeMdPath) && readFileSync(claudeMdPath, "utf8").includes(ROUTING_HEADING)
  );

  // 4. Hook script exists + executable, rule file dropped
  let exec = false;
  try {
    exec = (statSync(hookScript).mode & 0o111) !== 0;
  } catch {}
  check("Hook script is executable", existsSync(hookScript) && exec);
  check("Canonical routing-rule.md dropped", existsSync(ruleFile));

  // 5. Idempotency — second run must not duplicate the hook entry
  const run2 = runInstall(home);
  let hookCount2 = -1;
  try {
    const s = JSON.parse(readFileSync(settingsPath, "utf8"));
    hookCount2 = (s.hooks?.PreToolUse ?? []).filter((e) => e.matcher === HOOK_MATCHER).length;
  } catch {}
  check("Idempotent (no duplicate hook on re-run)", run2.status === 0 && hookCount2 === 1);
} finally {
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
