#!/usr/bin/env node
// Lifecycle regression tests for the MCP server process itself.
// No Chrome required — spawns server/dist/index.js on throwaway ports and
// asserts the process dies when its MCP client goes away, instead of living
// forever as an orphan (the WS servers used to keep the event loop alive).
//
// Covered:
//   1. stdin EOF (normal client exit)        → server exits 0
//   2. primary exit → live secondary promotes → multi-session stays working
//   3. parent death without stdin EOF        → ppid watchdog exits the server
//
// Run: npm run build:server && node scripts/test-lifecycle.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "../server/dist/index.js");

// Throwaway ports so tests never collide with a real session on 8765/8766.
const BASE_PORT = 18765;

let failures = 0;

function report(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  process.stdout.write(`  ${mark}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function spawnServer(port, extraEnv = {}) {
  const child = spawn("node", [serverEntry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      YOLO_WS_PORT: String(port),
      YOLO_SIBLING_PORT: String(port + 1),
      ...extraEnv,
    },
  });
  child.stderrText = "";
  child.stderr.on("data", (c) => (child.stderrText += c.toString()));
  return child;
}

function waitForStderr(child, pattern, timeoutMs) {
  return new Promise((resolve) => {
    if (pattern.test(child.stderrText)) return resolve(true);
    const timer = setTimeout(() => {
      child.stderr.off("data", onData);
      resolve(false);
    }, timeoutMs);
    const onData = () => {
      if (pattern.test(child.stderrText)) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        resolve(true);
      }
    };
    child.stderr.on("data", onData);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => resolve(null), timeoutMs); // null = still alive
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. stdin EOF → exit --------------------------------------------------
async function testStdinClose() {
  process.stdout.write("stdin EOF → server exits:\n");
  const child = spawnServer(BASE_PORT);
  const up = await waitForStderr(child, /primary on ws:/, 5000);
  report("server came up as primary", up);

  child.stdin.end();
  const code = await waitForExit(child, 3000);
  report("exits within 3s of stdin EOF", code !== null, code === null ? "still alive (orphan!)" : `exit code ${code}`);
  report("exit code is 0", code === 0, `got ${code}`);
  if (child.exitCode === null) child.kill("SIGKILL");
}

// ---- 2. primary exit → secondary promotes ----------------------------------
async function testSecondaryPromotion() {
  process.stdout.write("primary exits → secondary promotes:\n");
  const a = spawnServer(BASE_PORT + 10);
  const aUp = await waitForStderr(a, /primary on ws:/, 5000);
  report("A is primary", aUp);

  const b = spawnServer(BASE_PORT + 10);
  const bUp = await waitForStderr(b, /secondary, relaying/, 5000);
  report("B is secondary", bUp);

  a.stdin.end();
  const aCode = await waitForExit(a, 3000);
  report("A exits on stdin EOF", aCode !== null);

  const promoted = await waitForStderr(b, /primary on ws:/, 5000);
  report("B promotes to primary after A dies", promoted);

  b.stdin.end();
  const bCode = await waitForExit(b, 3000);
  report("B exits on stdin EOF", bCode !== null);
  for (const c of [a, b]) if (c.exitCode === null) c.kill("SIGKILL");
}

// ---- 3. parent death without stdin EOF → ppid watchdog ---------------------
async function testPpidWatchdog() {
  process.stdout.write("parent dies but stdin stays open → ppid watchdog exits:\n");
  // Intermediary spawns the server with inherited stdio and exits at once.
  // The server reparents to PID 1 while WE still hold its stdin pipe open,
  // so stdin never EOFs — only the watchdog can reap it.
  const intermediary = spawn(
    "node",
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const c = spawn(process.execPath, [process.argv[1]], { stdio: "inherit" });
       console.error("CHILD_PID=" + c.pid);
       c.unref();
       setTimeout(() => process.exit(0), 150);`,
      serverEntry,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        YOLO_WS_PORT: String(BASE_PORT + 20),
        YOLO_SIBLING_PORT: String(BASE_PORT + 21),
        YOLO_PPID_CHECK_MS: "200",
      },
    }
  );
  let errText = "";
  intermediary.stderr.on("data", (c) => (errText += c.toString()));
  await waitForExit(intermediary, 5000);
  const m = errText.match(/CHILD_PID=(\d+)/);
  if (!m) {
    report("spawned orphaned server via intermediary", false, errText.slice(0, 200));
    return;
  }
  const pid = Number(m[1]);
  report("spawned orphaned server via intermediary", true, `pid ${pid}`);

  // Keep intermediary's stdin pipe open on our side; poll for the server to die.
  const deadline = Date.now() + 5000;
  let alive = true;
  while (Date.now() < deadline) {
    alive = pidAlive(pid);
    if (!alive) break;
    await sleep(100);
  }
  report("watchdog reaps the server within 5s", !alive, alive ? "still alive (orphan!)" : "");
  if (alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

await testStdinClose();
await testSecondaryPromotion();
await testPpidWatchdog();

process.stdout.write(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
