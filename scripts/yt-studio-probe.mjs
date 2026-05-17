#!/usr/bin/env node
// YouTube Studio click-reliability probe (B3).
//
// Drives a non-destructive dirty-state test:
//   1. Pick an already-open monetization page tab (TAB_ID)
//   2. Verify Save button is initially disabled
//   3. Toggle the "Show mid-roll ads" checkbox using the chosen clickStrategy
//   4. Check whether Save becomes enabled
//   5. Print result. (Caller closes the tab to discard the change.)
//
// Usage:
//   TAB_ID=1746876277 STRATEGY=events       node scripts/yt-studio-probe.mjs
//   TAB_ID=1746876277 STRATEGY=native       node scripts/yt-studio-probe.mjs
//   TAB_ID=1746876277 STRATEGY=events+native node scripts/yt-studio-probe.mjs
//
// CHECKBOX_LABEL env overrides the default "Show mid-roll ads" label match.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "../server/dist/index.js");

const TAB_ID = Number(process.env.TAB_ID);
const STRATEGY = process.env.STRATEGY || "native";
const CHECKBOX_LABEL = process.env.CHECKBOX_LABEL || "Show mid-roll ads";
const SAVE_LABEL = process.env.SAVE_LABEL || "Save";

if (!TAB_ID) {
  console.error("set TAB_ID env to a YouTube Studio monetization tab id");
  process.exit(1);
}

const child = spawn("node", [serverEntry], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const r = pending.get(msg.id);
        pending.delete(msg.id);
        r(msg);
      }
    } catch {}
  }
});
child.stderr.on("data", (c) => process.stderr.write(`[srv] ${c}`));

function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
async function call(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  const c = res.result?.content?.[0];
  if (res.result?.isError) throw new Error(`${name}: ${c?.text ?? "unknown"}`);
  if (c?.type === "text") { try { return JSON.parse(c.text); } catch { return c.text; } }
  return res.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "yt-probe", version: "0" } });
  notify("notifications/initialized");
  // wait briefly for server/extension to be ready
  for (let i = 0; i < 20; i++) {
    try { const t = await call("listTabs", {}); if (t.length) break; } catch {}
    await sleep(200);
  }

  await call("setSafetyMode", { mode: "off" });

  console.log(`probe: tabId=${TAB_ID} strategy=${STRATEGY} checkbox="${CHECKBOX_LABEL}"`);

  const saveBefore = await call("getInteractables", { tabId: TAB_ID, labelMatch: SAVE_LABEL, limit: 50 });
  const saveBeforeNode = saveBefore.nodes?.[0];
  if (!saveBeforeNode) { console.error("Save button not found"); finish(1); return; }
  console.log(`save before: disabled=${saveBeforeNode.disabled ?? false}`);

  const cb = await call("getInteractables", { tabId: TAB_ID, labelMatch: CHECKBOX_LABEL, limit: 50, viewport: "all" });
  if (!cb.nodes?.length) {
    console.error(`checkbox "${CHECKBOX_LABEL}" not found. seen labels for Save+chevron probe:`);
    const all = await call("getInteractables", { tabId: TAB_ID, limit: 200 });
    for (const n of all.nodes) console.error(` - role=${n.role} label=${JSON.stringify(n.label)}`);
    finish(1); return;
  }
  console.log(`checkbox initial: ${JSON.stringify(cb.nodes[0])}`);

  // Click the checkbox with the chosen strategy.
  const t0 = Date.now();
  const clickRes = await call("clickByLabel", {
    tabId: TAB_ID,
    labelMatch: CHECKBOX_LABEL,
    clickStrategy: STRATEGY,
    viewport: "all",
  });
  const clickMs = Date.now() - t0;
  console.log(`click: ${clickMs}ms ${JSON.stringify(clickRes)}`);

  // Let the framework process the click + run its dirty bookkeeping.
  await sleep(300);

  const saveAfter = await call("getInteractables", { tabId: TAB_ID, labelMatch: SAVE_LABEL, limit: 50 });
  const saveAfterNode = saveAfter.nodes?.[0];
  if (!saveAfterNode) { console.error("Save button not found after click"); finish(1); return; }
  console.log(`save after:  disabled=${saveAfterNode.disabled ?? false}`);

  const wasDirty = !saveAfterNode.disabled;
  console.log(`result: ${wasDirty ? "PASS — Save became enabled (form dirtied)" : "FAIL — Save still disabled (click didn't dirty form)"}`);

  // Also probe the checkbox AX state to see if the click toggled its checked attribute.
  const cbAfter = await call("getInteractables", { tabId: TAB_ID, labelMatch: CHECKBOX_LABEL, limit: 50, viewport: "all" });
  console.log(`checkbox after:  ${JSON.stringify(cbAfter.nodes[0])}`);

  finish(wasDirty ? 0 : 2);
})().catch((e) => { console.error(e?.stack ?? e); finish(1); });

function finish(code) { try { child.kill(); } catch {} process.exit(code); }
