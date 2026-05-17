#!/usr/bin/env node
// Benchmark: a realistic browse → scroll → click → form-fill flow.
//
// Drives the MCP server over stdio (same harness as scripts/e2e.mjs) but injects a
// controlled heavy DOM into example.com so the test is deterministic and reproducible.
// Prints wall-clock per step and a total. Target: total < 15s.
//
// Usage:
//   node scripts/bench-flow.mjs           # default
//   BENCH_N=300 node scripts/bench-flow.mjs
//
// Requires the Chrome extension to be loaded + connected, and an https tab open.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "../server/dist/index.js");

// Number of interactive widgets to inject. Bigger = heavier getInteractables.
const N = Number(process.env.BENCH_N ?? 200);
// Target threshold for the overall flow (ms).
const BUDGET_MS = Number(process.env.BENCH_BUDGET_MS ?? 15000);

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
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
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
  if (c?.type === "text") {
    try { return JSON.parse(c.text); } catch { return c.text; }
  }
  if (c?.type === "image") {
    return { _image: true, mimeType: c.mimeType, bytes: c.data.length };
  }
  return res.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
async function step(name, fn) {
  const t0 = Date.now();
  let ok = true;
  let info = "";
  let value;
  try {
    value = await fn();
    info = summarize(value);
  } catch (e) {
    ok = false;
    info = e?.message ?? String(e);
  }
  const ms = Date.now() - t0;
  steps.push({ name, ok, ms, info });
  const status = ok ? "✓" : "✗";
  console.log(`${status} ${pad(ms + "ms", 8)} ${name}  ${info}`);
  if (!ok) throw new Error(`${name} failed: ${info}`);
  return value;
}
function summarize(o) {
  if (o == null) return "";
  if (o._image) return `[image ${o.mimeType} ${o.bytes}B]`;
  if (Array.isArray(o)) return `[array len=${o.length}]`;
  const s = JSON.stringify(o);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}
function pad(s, n) { return (s + " ".repeat(n)).slice(0, n); }

(async () => {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "bench", version: "0" },
  });
  notify("notifications/initialized");

  // Wait for the extension to connect.
  let tabs = null;
  for (let i = 0; i < 30; i++) {
    try {
      tabs = await call("listTabs", {});
      if (Array.isArray(tabs) && tabs.length) break;
    } catch {}
    await sleep(1000);
  }
  if (!tabs?.length) {
    console.error("extension never connected");
    finish(1);
    return;
  }

  // Pick an attachable https tab.
  const cands = tabs.filter((t) => /^https?:/.test(t.url ?? ""));
  let target = null;
  for (const c of cands) {
    try { await call("getTabInfo", { tabId: c.id }); target = c; break; } catch {}
  }
  if (!target) {
    console.error("no attachable https tab");
    finish(1);
    return;
  }
  const tabId = target.id;
  const originalUrl = target.url;
  console.log(`target tab: ${tabId}  N=${N}  budget=${BUDGET_MS}ms`);

  // Silence the safety overlay; bench measures the happy-path wire time, not human latency.
  await call("setSafetyMode", { mode: "off" });

  const flowStart = Date.now();

  // --- 1. Navigate + settle ---------------------------------------------------
  // navigate auto-waits for network idle now, so we don't need a chained waitForStable
  // after every hop. A realistic flow visits several pages.
  await step("navigate example.com", () => call("navigate", { tabId, url: "https://example.com/" }));
  await step("navigate iana.org", () => call("navigate", { tabId, url: "https://www.iana.org/help/example-domains" }));
  await step("getPageText (read)", () => call("getPageText", { tabId, maxChars: 800 }));
  await step("navigate back to example.com", () => call("navigate", { tabId, url: "https://example.com/" }));
  await step("navigate iana root", () => call("navigate", { tabId, url: "https://www.iana.org/" }));
  await step("navigate final", () => call("navigate", { tabId, url: "https://example.com/" }));

  // --- 2. Inject heavy DOM (deterministic content) ---------------------------
  await step(`inject ${N} widgets + form`, () => call("evalJs", {
    tabId,
    expression: `(() => {
      document.querySelectorAll('#bench-host').forEach(n => n.remove());
      const host = document.createElement('div');
      host.id = 'bench-host';
      host.style.cssText = 'padding:16px;font:14px/1.4 system-ui;';
      const N = ${N};
      let html = '<h1>Bench Flow</h1><p>Click any button. Then scroll, fill the form, submit.</p>';
      html += '<div id="grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0;">';
      for (let i = 0; i < N; i++) {
        html += '<button class="card" data-i="' + i + '" aria-label="card-' + i + '">card-' + i + '</button>';
      }
      html += '</div>';
      html += '<form id="bench-form" style="display:grid;grid-template-columns:1fr;gap:8px;margin-top:24px;max-width:600px;">';
      const fields = [
        ['fullname', 'text'],
        ['email', 'text'],
        ['addr1', 'text'],
        ['city', 'text'],
        ['zip', 'text'],
      ];
      // No <label> elements — the AX tree's "name" for an <input> uses the associated
      // <label> text over aria-label when both are present. Using only aria-label keeps
      // the bench's label-based lookups unambiguous.
      for (const [name, type] of fields) {
        html += '<input id="bf-' + name + '" name="' + name + '" type="' + type + '" aria-label="' + name + '" placeholder="' + name + '" style="font-size:16px;padding:6px;">';
      }
      html += '<button type="submit" id="bf-submit" aria-label="submit-form">Submit</button>';
      html += '</form>';
      html += '<div id="status" style="margin-top:16px;font-weight:bold;">idle</div>';
      host.innerHTML = html;
      document.body.appendChild(host);
      // Plumbing.
      window.__benchState = { lastCard: null, submitted: null };
      document.querySelectorAll('.card').forEach((b) => {
        b.addEventListener('click', () => {
          window.__benchState.lastCard = b.getAttribute('data-i');
          document.getElementById('status').textContent = 'card-' + b.getAttribute('data-i');
        });
      });
      document.getElementById('bench-form').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const fd = {};
        new FormData(ev.target).forEach((v, k) => fd[k] = v);
        window.__benchState.submitted = fd;
        document.getElementById('status').textContent = 'submitted';
      });
      return { injected: true, N };
    })()`,
  }));

  // --- 3. Browse: screenshot the page ----------------------------------------
  await step("screenshot viewport", () => call("screenshot", { tabId, format: "jpeg", quality: 60 }));

  // --- 4. First snapshot of interactables (visible) --------------------------
  const first = await step("getInteractables visible#1", () => call("getInteractables", { tabId, limit: 200 }));
  if (!first.nodes?.length) throw new Error("no interactables");

  // --- 5. Scroll down so a different card row enters the viewport ------------
  await step("scroll by 800", () => call("scroll", { tabId, by: { x: 0, y: 800 } }));
  await sleep(80); // tiny settle for layout / paint

  const second = await step("getInteractables visible#2", () => call("getInteractables", { tabId, limit: 200 }));
  if (!second.nodes?.length) throw new Error("no interactables after scroll");

  // --- 6. Click a card that's now visible -----------------------------------
  const targetCard = second.nodes.find((n) => /^card-\d+$/.test(n.label ?? ""));
  if (!targetCard) throw new Error("no card visible after scroll");
  const targetCardIdx = targetCard.label.replace("card-", "");
  await step(`click ${targetCard.label}`, () => call("click", { tabId, stableId: targetCard.stableId }));
  // Verify state side-effect.
  await step("verify click took effect", async () => {
    const r = await call("evalJs", { tabId, expression: "window.__benchState.lastCard" });
    if (String(r.value) !== String(targetCardIdx)) {
      throw new Error(`lastCard=${r.value}, expected ${targetCardIdx}`);
    }
    return { lastCard: r.value };
  });

  // --- 7. Scroll to form -----------------------------------------------------
  await step("scroll to form", () => call("evalJs", {
    tabId,
    expression: `(() => {
      const f = document.getElementById('bench-form');
      f.scrollIntoView({block:'start'});
      const r = f.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, scrollY: window.scrollY };
    })()`,
  }));
  await sleep(120);

  // --- 8. Form fill: 5 fields -----------------------------------------------
  // Refresh interactables to discover the form inputs in the new viewport.
  // The form is small (5 inputs); on a heavy page the inputs might be deeper in the AX
  // tree than `limit` covers, so we use viewport:"all" and let the filter happen here.
  const formInter = await step("getInteractables (form viewport)", () =>
    call("getInteractables", { tabId, viewport: "all", limit: 500 })
  );
  const fieldNames = ["fullname", "email", "addr1", "city", "zip"];
  const fieldValues = {
    fullname: "Taro Yamada",
    email: "taro@example.com",
    addr1: "1-2-3 Shibuya",
    city: "Tokyo",
    zip: "150-0002",
  };
  for (const name of fieldNames) {
    const node = formInter.nodes.find((n) => n.label === name);
    if (!node) {
      const allLabels = formInter.nodes.map((n) => `${n.role}:${n.label}`).join(", ");
      throw new Error(`form field '${name}' not found. seen: ${allLabels}`);
    }
    await step(`type ${name}`, () =>
      call("type", { tabId, stableId: node.stableId, text: fieldValues[name] })
    );
  }

  // --- 8b. List-click scenario (X-recs-like): click 3 Follow buttons --------
  // Mimics the "Who to follow" page — many cards with a per-card action button. The
  // old flow forced getInteractables → find → click sequences and tempted us to
  // navigate to each profile to verify. The new clickByLabel collapses all of that.
  await step("inject follow list", () => call("evalJs", {
    tabId,
    expression: `(() => {
      document.querySelectorAll('#bench-follow-list').forEach(n => n.remove());
      const host = document.createElement('div');
      host.id = 'bench-follow-list';
      host.style.cssText = 'padding:16px;font:14px/1.4 system-ui;';
      window.__benchFollow = { followed: [] };
      let html = '<h2>Who to follow</h2>';
      const users = Array.from({length: 8}, (_, i) => 'user' + (i + 1));
      for (const u of users) {
        html += '<div style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #444;">';
        html += '<span style="flex:1;">@' + u + '</span>';
        html += '<button aria-label="Follow @' + u + '" data-handle="' + u + '">Follow</button>';
        html += '</div>';
      }
      host.innerHTML = html;
      document.body.appendChild(host);
      host.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => {
          const h = b.getAttribute('data-handle');
          window.__benchFollow.followed.push(h);
          b.textContent = 'Following';
          b.setAttribute('aria-label', 'Following @' + h);
        });
      });
      host.scrollIntoView({block:'start'});
      return { users };
    })()`,
  }));
  // 3 clicks using clickByLabel. After each click the label of the clicked button
  // changes from "Follow @userN" to "Following @userN", so calling with the same
  // labelMatch each time naturally walks down the remaining unfollowed items.
  for (let i = 0; i < 3; i++) {
    await step(`clickByLabel Follow #${i + 1}`, () => call("clickByLabel", {
      tabId,
      labelMatch: "Follow @",
      roleMatch: "button",
    }));
  }
  await step("verify 3 follows", async () => {
    const r = await call("evalJs", { tabId, expression: "JSON.stringify(window.__benchFollow.followed)" });
    const v = r.value ? JSON.parse(r.value) : [];
    if (v.length !== 3) throw new Error(`followed ${v.length}, expected 3`);
    return { followed: v };
  });

  // --- 8c. clickStrategy sanity: native + events+native still work and stay fast --
  // Per-click budget ~50ms keeps us honest about not re-introducing the 5s mouseMoved
  // regression (see PROJECT.md D18 / D22).
  await step("inject strategy probe", () => call("evalJs", {
    tabId,
    expression: `(() => {
      document.querySelectorAll('#bench-strat').forEach(n => n.remove());
      const host = document.createElement('div');
      host.id = 'bench-strat';
      host.style.cssText = 'padding:16px;font:14px/1.4 system-ui;';
      window.__benchStrat = { events: 0, native: 0, both: 0 };
      host.innerHTML = '<div style="display:flex;gap:8px;">'
        + '<button aria-label="strat-events">events</button>'
        + '<button aria-label="strat-native">native</button>'
        + '<button aria-label="strat-both">both</button>'
        + '</div>';
      document.body.appendChild(host);
      host.scrollIntoView({block:'start'});
      host.querySelector('button[aria-label="strat-events"]').addEventListener('click', () => window.__benchStrat.events++);
      host.querySelector('button[aria-label="strat-native"]').addEventListener('click', () => window.__benchStrat.native++);
      host.querySelector('button[aria-label="strat-both"]').addEventListener('click', () => window.__benchStrat.both++);
      return { ok: true };
    })()`,
  }));
  const STRAT_BUDGET = 50;
  for (const strat of ["events", "native", "events+native"]) {
    const label = `strat-${strat === "events+native" ? "both" : strat}`;
    const t0 = Date.now();
    await call("clickByLabel", { tabId, labelMatch: label, roleMatch: "button", clickStrategy: strat });
    const ms = Date.now() - t0;
    steps.push({ name: `clickStrategy ${strat}`, ok: true, ms, info: "" });
    console.log(`${ms <= STRAT_BUDGET ? "✓" : "⚠"} ${pad(ms + "ms", 8)} clickStrategy ${strat}`);
    if (ms > STRAT_BUDGET * 10) throw new Error(`clickStrategy ${strat} took ${ms}ms (budget ${STRAT_BUDGET}ms, hard ceiling ${STRAT_BUDGET * 10}ms)`);
  }
  await step("verify strategy counts", async () => {
    const r = await call("evalJs", { tabId, expression: "JSON.stringify(window.__benchStrat)" });
    const v = r.value ? JSON.parse(r.value) : null;
    if (!v) throw new Error("strat state missing");
    if (v.events !== 1) throw new Error(`events count ${v.events}, expected 1`);
    if (v.native !== 1) throw new Error(`native count ${v.native}, expected 1`);
    if (v.both !== 2) throw new Error(`events+native count ${v.both}, expected 2 (events fires + native fires)`);
    return v;
  });

  // --- 9. Submit -------------------------------------------------------------
  const submit = formInter.nodes.find((n) => n.label === "submit-form");
  if (!submit) throw new Error("submit button not found in interactables");
  await step("click submit", () => call("click", { tabId, stableId: submit.stableId }));
  await step("verify submission", async () => {
    const r = await call("evalJs", { tabId, expression: "JSON.stringify(window.__benchState.submitted)" });
    const v = r.value ? JSON.parse(r.value) : null;
    if (!v) throw new Error("not submitted");
    for (const [k, want] of Object.entries(fieldValues)) {
      if (v[k] !== want) throw new Error(`field ${k}=${v[k]}, expected ${want}`);
    }
    return { submitted: true };
  });

  const totalMs = Date.now() - flowStart;
  const overhead = steps.reduce((a, s) => a + s.ms, 0);

  // --- restore -------------------------------------------------------------
  await call("evalJs", { tabId, expression: "document.querySelectorAll('#bench-host').forEach(n=>n.remove()); 'ok'" }).catch(()=>{});
  if (originalUrl && !/^chrome:/.test(originalUrl)) {
    await call("navigate", { tabId, url: originalUrl }).catch(() => {});
  }

  console.log();
  console.log("─".repeat(72));
  console.log(`steps:       ${steps.length}`);
  console.log(`step sum:    ${overhead}ms`);
  console.log(`flow total:  ${totalMs}ms   budget: ${BUDGET_MS}ms`);
  console.log(`result:      ${totalMs <= BUDGET_MS ? "PASS" : "FAIL"} (${totalMs <= BUDGET_MS ? "under" : "OVER"} budget)`);
  // Top slow steps for triage.
  const top = [...steps].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log("top 5 slowest:");
  for (const s of top) console.log(`  ${pad(s.ms + "ms", 8)} ${s.name}`);

  finish(totalMs <= BUDGET_MS ? 0 : 2);
})().catch((e) => {
  console.error(e?.stack ?? e);
  finish(1);
});

function finish(code) {
  try { child.kill(); } catch {}
  process.exit(code);
}
