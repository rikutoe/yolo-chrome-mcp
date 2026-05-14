#!/usr/bin/env node
// E2E driver: spawns the MCP server, runs a sequence of tool calls via stdio,
// prints a pass/fail report.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "../server/dist/index.js");

const child = spawn("node", [serverEntry], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map(); // id -> resolve
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const r = pending.get(msg.id);
      pending.delete(msg.id);
      r(msg);
    }
  }
});

child.stderr.on("data", (c) => process.stderr.write(`[srv] ${c}`));

function rpc(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function callTool(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  const c = res.result?.content?.[0];
  if (res.result?.isError) throw new Error(`${name}: ${c?.text ?? "unknown"}`);
  if (c?.type === "text") {
    try {
      return JSON.parse(c.text);
    } catch {
      return c.text;
    }
  }
  if (c?.type === "image") {
    return { _image: true, mimeType: c.mimeType, bytes: c.data.length };
  }
  return res.result;
}

function pass(n, info = "") {
  console.log(`✓ ${n} ${info}`);
}
function fail(n, e) {
  console.log(`✗ ${n} ${e?.message ?? e}`);
  failures++;
}
let failures = 0;

async function tryStep(name, fn) {
  try {
    const out = await fn();
    pass(name, summarize(out));
    return out;
  } catch (e) {
    fail(name, e);
    return null;
  }
}

function summarize(o) {
  if (o == null) return "";
  if (o._image) return `[image ${o.mimeType} ${o.bytes}B]`;
  const s = JSON.stringify(o);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. handshake
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  notify("notifications/initialized");

  const toolsList = await rpc("tools/list");
  console.log(`[tools/list] count=${toolsList.result.tools.length}`);

  // wait for extension to (re)connect
  console.log("waiting for extension...");
  for (let i = 0; i < 30; i++) {
    try {
      const tabs = await callTool("listTabs", {});
      if (Array.isArray(tabs) && tabs.length > 0) {
        pass("listTabs", `found ${tabs.length} tabs`);
        await runOn(tabs);
        break;
      }
    } catch (e) {
      // still connecting
    }
    await sleep(1000);
    if (i === 29) {
      fail("listTabs", new Error("extension never connected"));
    }
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  child.kill();
  process.exit(failures === 0 ? 0 : 1);
})();

async function runOn(tabs) {
  // Try to attach to each https tab until one works. Some tabs (chrome-extension://
  // new-tab overrides, discarded tabs) refuse CDP attach.
  const candidates = tabs.filter((t) => /^https?:/.test(t.url ?? ""));
  let target = null;
  for (const c of candidates) {
    try {
      await callTool("getTabInfo", { tabId: c.id });
      target = c;
      break;
    } catch (e) {
      console.log(`  skip ${c.id} (${c.url?.slice(0, 50)}…): ${e.message.slice(0, 80)}`);
    }
  }
  if (!target) {
    fail("getTabInfo", new Error("no attachable https tab found"));
    return;
  }
  console.log(`target: ${target.id} ${target.url}`);
  const tabId = target.id;

  await tryStep("setSafetyMode=off", () =>
    callTool("setSafetyMode", { mode: "off" })
  );
  await tryStep("screenshot (viewport)", () =>
    callTool("screenshot", { tabId })
  );
  await tryStep("getPageText", () => callTool("getPageText", { tabId }));
  await tryStep("waitForStable", () =>
    callTool("waitForStable", { tabId, timeout: 3000 })
  );
  const inter = await tryStep("getInteractables", () =>
    callTool("getInteractables", { tabId, limit: 20 })
  );
  await tryStep("getConsoleLogs (all)", () =>
    callTool("getConsoleLogs", { tabId, level: "all", limit: 5 })
  );
  await tryStep("getNetworkActivity", () =>
    callTool("getNetworkActivity", { tabId, failedOnly: false, limit: 5 })
  );
  await tryStep("getStorage (cookie)", () =>
    callTool("getStorage", { tabId, types: ["cookie"] })
  );
  await tryStep("scroll", () =>
    callTool("scroll", { tabId, by: { x: 0, y: 100 } })
  );
  await tryStep("evalJs", () =>
    callTool("evalJs", {
      tabId,
      expression: "({title: document.title, h: location.host})",
    })
  );
  // Click test only if interactables found
  if (inter?.nodes?.length) {
    const link = inter.nodes.find((n) => n.role === "link") ?? inter.nodes[0];
    console.log(`will try click on: ${link.role} "${link.label}"`);
    // Skip click to avoid navigation away.
  }
  await tryStep("setSafetyMode=dangerous-only (restore)", () =>
    callTool("setSafetyMode", { mode: "dangerous-only" })
  );
}
