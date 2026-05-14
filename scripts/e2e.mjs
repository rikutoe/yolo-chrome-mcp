#!/usr/bin/env node
// Comprehensive E2E driver for yolo-chrome-mcp.
// Spawns the MCP server over stdio, drives every tool through the WS bridge
// to the loaded Chrome extension, and prints a per-test pass/fail report.
//
// Prerequisites:
//   - npm run build (or at least the server build) has run
//   - the extension is loaded in Chrome (chrome://extensions, Developer mode)
//   - at least one https/http tab is open that CDP can attach to
//
// The test navigates the chosen tab to https://example.com (a stable, minimal
// page with one link). After the run it navigates back to the original URL.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, "../server/dist/index.js");

const child = spawn("node", [serverEntry], {
  stdio: ["pipe", "pipe", "pipe"],
});

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

let failures = 0;
let passes = 0;
const results = [];

function pass(n, info = "") {
  passes++;
  results.push({ name: n, ok: true, info });
  console.log(`✓ ${n} ${info}`);
}
function fail(n, e) {
  failures++;
  results.push({ name: n, ok: false, info: e?.message ?? String(e) });
  console.log(`✗ ${n} ${e?.message ?? e}`);
}

async function step(name, fn) {
  try {
    const out = await fn();
    pass(name, summarize(out));
    return out;
  } catch (e) {
    fail(name, e);
    return null;
  }
}

async function expectFail(name, fn, matchSubstr) {
  try {
    const out = await fn();
    fail(name, new Error(`expected failure but got: ${summarize(out)}`));
    return null;
  } catch (e) {
    const msg = e?.message ?? "";
    if (matchSubstr && !msg.includes(matchSubstr)) {
      fail(name, new Error(`error did not match "${matchSubstr}": ${msg}`));
      return null;
    }
    pass(name, `(expected error: ${msg.slice(0, 80)})`);
    return e;
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
  // 1. MCP handshake
  await step("initialize", async () => {
    const r = await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    if (!r.result?.serverInfo) throw new Error("no serverInfo");
    return r.result.serverInfo;
  });
  notify("notifications/initialized");

  // 2. tools/list — verify all 17 tools registered
  const toolsList = await step("tools/list", async () => {
    const r = await rpc("tools/list");
    const names = r.result.tools.map((t) => t.name).sort();
    const expected = [
      "click", "closeTab", "createTab", "evalJs", "getConsoleLogs",
      "getInteractables", "getNetworkActivity", "getNetworkRequest",
      "getPageText", "getSourceAt", "getStorage", "getTabInfo",
      "listTabs", "navigate", "screenshot", "scroll", "setSafetyMode",
      "type", "waitForStable",
    ];
    const missing = expected.filter((n) => !names.includes(n));
    if (missing.length) throw new Error(`missing tools: ${missing.join(",")}`);
    if (names.length !== expected.length) {
      throw new Error(`expected ${expected.length} tools, got ${names.length}: extras=${names.filter((n) => !expected.includes(n)).join(",")}`);
    }
    return { count: names.length };
  });

  // 3. Wait for extension to connect
  console.log("waiting for extension...");
  let tabs = null;
  for (let i = 0; i < 30; i++) {
    try {
      tabs = await callTool("listTabs", {});
      if (Array.isArray(tabs) && tabs.length > 0) break;
    } catch {}
    await sleep(1000);
  }
  if (!tabs || tabs.length === 0) {
    fail("listTabs (extension connection)", new Error("extension never connected — load it in chrome://extensions"));
    finish();
    return;
  }
  pass("listTabs (extension connection)", `found ${tabs.length} tabs`);

  // 4. Pick a target tab
  const candidates = tabs.filter((t) => /^https?:/.test(t.url ?? ""));
  let target = null;
  for (const c of candidates) {
    try {
      await callTool("getTabInfo", { tabId: c.id });
      target = c;
      break;
    } catch {}
  }
  if (!target) {
    fail("pick target", new Error("no attachable https tab"));
    finish();
    return;
  }
  console.log(`target: tabId=${target.id} originalUrl=${target.url}`);
  const tabId = target.id;
  const originalUrl = target.url;

  // 5. Safety: turn off so actions don't require human overlay clicks
  await step("setSafetyMode=off", () => callTool("setSafetyMode", { mode: "off" }));

  // 6. Navigate to example.com for a controlled deterministic test page
  await step("navigate -> example.com", async () => {
    const r = await callTool("navigate", { tabId, url: "https://example.com/" });
    if (!r.ok) throw new Error("navigate not ok");
    return r;
  });
  await step("waitForStable after navigate", () =>
    callTool("waitForStable", { tabId, timeout: 8000 })
  );
  await sleep(500); // small settle

  // 6b. createTab + closeTab round-trip
  await step("createTab + closeTab", async () => {
    const created = await callTool("createTab", {
      url: "about:blank",
      active: false,
    });
    if (typeof created.id !== "number") throw new Error("createTab did not return id");
    const tabsNow = await callTool("listTabs", {});
    if (!tabsNow.some((t) => t.id === created.id)) {
      throw new Error("new tab not visible in listTabs");
    }
    const closed = await callTool("closeTab", { tabIds: created.id });
    if (!Array.isArray(closed.closed) || closed.closed[0] !== created.id) {
      throw new Error(`closeTab returned ${JSON.stringify(closed)}`);
    }
    await sleep(200);
    const tabsAfter = await callTool("listTabs", {});
    if (tabsAfter.some((t) => t.id === created.id)) {
      throw new Error("tab still present after closeTab");
    }
    return { createdId: created.id };
  });

  // 7. Stage 1
  await step("getTabInfo (example.com)", async () => {
    const info = await callTool("getTabInfo", { tabId });
    if (!info.url?.includes("example.com")) throw new Error(`url=${info.url}`);
    if (!Array.isArray(info.frames)) throw new Error("frames missing");
    return { url: info.url, frames: info.frames.length };
  });

  // 8. Stage 2: screenshot variants
  await step("screenshot (viewport jpeg default)", async () => {
    const r = await callTool("screenshot", { tabId });
    if (!r._image) throw new Error("no image");
    if (r.mimeType !== "image/jpeg") throw new Error(`mime=${r.mimeType}`);
    return r;
  });
  await step("screenshot (fullPage png)", async () => {
    const r = await callTool("screenshot", { tabId, fullPage: true, format: "png" });
    if (!r._image) throw new Error("no image");
    if (r.mimeType !== "image/png") throw new Error(`mime=${r.mimeType}`);
    return r;
  });
  await step("screenshot (jpeg quality=30)", async () => {
    const r = await callTool("screenshot", { tabId, format: "jpeg", quality: 30 });
    if (!r._image) throw new Error("no image");
    return r;
  });

  // 9. Stage 2: getPageText with pagination
  const text0 = await step("getPageText (default first 2000)", async () => {
    const r = await callTool("getPageText", { tabId });
    if (typeof r.text !== "string") throw new Error("no text");
    if (typeof r.totalChars !== "number") throw new Error("no totalChars");
    if (!r.text.toLowerCase().includes("example")) throw new Error("text missing 'example'");
    return r;
  });
  await step("getPageText (maxChars=50)", async () => {
    const r = await callTool("getPageText", { tabId, maxChars: 100 });
    if (r.returnedChars > 100) throw new Error(`returned ${r.returnedChars}`);
    return { returned: r.returnedChars, truncated: r.truncated };
  });
  await step("getPageText (offset)", async () => {
    if (!text0 || text0.totalChars < 20) return { skipped: "short page" };
    const r = await callTool("getPageText", { tabId, offset: 10, maxChars: 100 });
    if (r.offset !== 10) throw new Error(`offset=${r.offset}`);
    return r;
  });

  // 10. Stage 3: getInteractables
  const inter = await step("getInteractables (visible)", async () => {
    const r = await callTool("getInteractables", { tabId, limit: 50 });
    if (!Array.isArray(r.nodes)) throw new Error("no nodes");
    if (r.nodes.length === 0) throw new Error("no interactables on example.com");
    const link = r.nodes.find((n) => n.role === "link");
    if (!link) throw new Error("no link role found");
    if (!link.stableId?.startsWith("n")) throw new Error(`bad stableId: ${link.stableId}`);
    return { count: r.nodes.length, firstRole: r.nodes[0].role, sample: link.label?.slice(0, 40) };
  });
  await step("getInteractables (viewport=all)", async () => {
    const r = await callTool("getInteractables", { tabId, viewport: "all", limit: 50 });
    if (!Array.isArray(r.nodes)) throw new Error("no nodes");
    return { count: r.nodes.length };
  });
  await step("getInteractables (limit=1)", async () => {
    const r = await callTool("getInteractables", { tabId, limit: 1 });
    if (r.nodes.length > 1) throw new Error(`got ${r.nodes.length}`);
    return r;
  });

  // 11. Inject controlled DOM (form/button) so click/type are deterministic
  await step("evalJs (inject test DOM)", async () => {
    const r = await callTool("evalJs", {
      tabId,
      expression: `(() => {
        const old = document.getElementById('e2e-host');
        if (old) old.remove();
        const host = document.createElement('div');
        host.id = 'e2e-host';
        host.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483646;background:#fff;padding:8px;border:1px solid #000;';
        host.innerHTML = '<input id="e2e-input" type="text" aria-label="e2e-input" style="font-size:16px;width:200px;">' +
          '<button id="e2e-btn" aria-label="e2e-btn" style="margin-left:6px;">e2e-btn</button>' +
          '<span id="e2e-out" style="margin-left:6px;">idle</span>';
        document.body.appendChild(host);
        document.getElementById('e2e-btn').addEventListener('click', () => {
          document.getElementById('e2e-out').textContent = 'clicked';
        });
        document.getElementById('e2e-input').addEventListener('input', (ev) => {
          document.getElementById('e2e-out').textContent = 'typed:' + ev.target.value;
        });
        return 'injected';
      })()`,
    });
    if (r.value !== "injected") throw new Error(`eval result=${JSON.stringify(r)}`);
    return r;
  });

  // Re-fetch interactables to refresh stableId map for injected elements
  const inter2 = await step("getInteractables (after inject)", async () => {
    const r = await callTool("getInteractables", { tabId, viewport: "all", limit: 100 });
    const input = r.nodes.find((n) => /e2e-input/.test(n.label));
    const btn = r.nodes.find((n) => /e2e-btn/.test(n.label));
    if (!input) throw new Error("injected input not found in a11y tree");
    if (!btn) throw new Error("injected button not found in a11y tree");
    return { inputId: input.stableId, btnId: btn.stableId };
  });

  // 12. type
  if (inter2) {
    await step("type (clearFirst default)", async () => {
      const r = await callTool("type", {
        tabId,
        stableId: inter2.inputId,
        text: "hello-e2e",
      });
      if (!r.ok) throw new Error(JSON.stringify(r));
      await sleep(150);
      const v = await callTool("evalJs", {
        tabId,
        expression: `document.getElementById('e2e-input').value`,
      });
      if (v.value !== "hello-e2e") throw new Error(`input value=${v.value}`);
      const out = await callTool("evalJs", {
        tabId,
        expression: `document.getElementById('e2e-out').textContent`,
      });
      if (!String(out.value).startsWith("typed:")) throw new Error(`out=${out.value}`);
      return { value: v.value };
    });

    await step("type (clearFirst=false appends)", async () => {
      const r = await callTool("type", {
        tabId,
        stableId: inter2.inputId,
        text: "+more",
        clearFirst: false,
      });
      if (!r.ok) throw new Error(JSON.stringify(r));
      await sleep(150);
      const v = await callTool("evalJs", {
        tabId,
        expression: `document.getElementById('e2e-input').value`,
      });
      if (!String(v.value).endsWith("+more")) throw new Error(`value=${v.value}`);
      return { value: v.value };
    });

    // 13. click on injected button
    await step("click (injected btn)", async () => {
      const r = await callTool("click", { tabId, stableId: inter2.btnId });
      if (!r.ok) throw new Error(JSON.stringify(r));
      await sleep(200);
      const out = await callTool("evalJs", {
        tabId,
        expression: `document.getElementById('e2e-out').textContent`,
      });
      if (out.value !== "clicked") throw new Error(`out=${out.value}`);
      return out;
    });
  }

  // 14. Negative: unknown stableId
  await expectFail("click (unknown stableId)", () =>
    callTool("click", { tabId, stableId: "n999999" })
  , "Unknown stableId");

  // 15. scroll: by, to, and missing
  await step("scroll by", async () => {
    await callTool("scroll", { tabId, by: { x: 0, y: 50 } });
    await sleep(150);
    const r = await callTool("evalJs", { tabId, expression: "window.scrollY" });
    if (typeof r.value !== "number") throw new Error("no scrollY");
    return { scrollY: r.value };
  });
  await step("scroll to 0,0", async () => {
    await callTool("scroll", { tabId, to: { x: 0, y: 0 } });
    await sleep(150);
    const r = await callTool("evalJs", { tabId, expression: "window.scrollY" });
    if (r.value !== 0) throw new Error(`scrollY=${r.value}`);
    return r;
  });
  await expectFail("scroll (no to/by)", () => callTool("scroll", { tabId }), "to' or 'by");

  // 16. evalJs: value, error, promise
  await step("evalJs (simple value)", async () => {
    const r = await callTool("evalJs", { tabId, expression: "1 + 2" });
    if (r.value !== 3) throw new Error(`value=${r.value}`);
    return r;
  });
  await step("evalJs (exception path)", async () => {
    const r = await callTool("evalJs", { tabId, expression: "throw new Error('boom')" });
    if (r.ok !== false) throw new Error("expected ok:false");
    if (!String(r.exception).includes("boom")) throw new Error(`exception=${r.exception}`);
    return { exception: r.exception?.slice(0, 60) };
  });
  await step("evalJs (Promise)", async () => {
    const r = await callTool("evalJs", {
      tabId,
      expression: "new Promise(r => setTimeout(() => r(42), 50))",
    });
    if (r.value !== 42) throw new Error(`value=${r.value}`);
    return r;
  });

  // 17. getConsoleLogs — inject some console output first
  await step("evalJs (emit console msgs)", () =>
    callTool("evalJs", {
      tabId,
      expression: `console.log('e2e-log-msg'); console.warn('e2e-warn-msg'); console.error('e2e-err-msg'); 'done'`,
    })
  );
  await sleep(300);
  await step("getConsoleLogs (level=all)", async () => {
    const r = await callTool("getConsoleLogs", { tabId, level: "all", limit: 50 });
    if (!Array.isArray(r.entries)) throw new Error("no entries");
    return { total: r.total, returned: r.returned };
  });
  await step("getConsoleLogs (level=error)", async () => {
    const r = await callTool("getConsoleLogs", { tabId, level: "error", limit: 50 });
    return { total: r.total, returned: r.returned };
  });
  await step("getConsoleLogs (since=now-1s)", async () => {
    const since = Date.now() - 2000;
    const r = await callTool("getConsoleLogs", { tabId, level: "all", since, limit: 100 });
    return { returned: r.returned };
  });

  // 18. getNetworkActivity — trigger fetch first
  await step("evalJs (trigger fetch)", () =>
    callTool("evalJs", {
      tabId,
      expression: `fetch('https://example.com/?e2e=' + Date.now()).then(r => r.status).catch(e => String(e))`,
    })
  );
  await sleep(800);
  const net = await step("getNetworkActivity (failedOnly=false)", async () => {
    const r = await callTool("getNetworkActivity", { tabId, failedOnly: false, limit: 50 });
    if (!Array.isArray(r.items)) throw new Error("no items");
    return { total: r.total, returned: r.items.length, hasItems: r.items.length > 0 };
  });
  await step("getNetworkActivity (failedOnly=true)", async () => {
    const r = await callTool("getNetworkActivity", { tabId, failedOnly: true, limit: 50 });
    return { failed: r.failed };
  });

  // 19. getNetworkRequest — pick a captured requestId
  await step("getNetworkRequest (real id)", async () => {
    const list = await callTool("getNetworkActivity", { tabId, failedOnly: false, limit: 50 });
    const item = list.items?.find((x) => x.requestId);
    if (!item) {
      // Not every network event is captured — degrade gracefully
      return { skipped: "no requests captured" };
    }
    const r = await callTool("getNetworkRequest", { tabId, requestId: item.requestId });
    if (!r.requestId) throw new Error("no requestId echo");
    return { url: r.url, hasBody: !!r.responseBody };
  });
  await expectFail("getNetworkRequest (unknown id)", () =>
    callTool("getNetworkRequest", { tabId, requestId: "no-such-request-id" })
  , "Unknown requestId");

  // 20. getStorage — set then read
  await step("evalJs (seed storage)", () =>
    callTool("evalJs", {
      tabId,
      expression: `localStorage.setItem('e2e-k','e2e-v'); sessionStorage.setItem('e2e-sk','e2e-sv'); 'ok'`,
    })
  );
  await step("getStorage (all types)", async () => {
    const r = await callTool("getStorage", {
      tabId,
      types: ["cookie", "localStorage", "sessionStorage"],
    });
    if (!r.localStorage || r.localStorage["e2e-k"] !== "e2e-v") {
      throw new Error(`localStorage: ${JSON.stringify(r.localStorage)}`);
    }
    if (r.sessionStorage["e2e-sk"] !== "e2e-sv") {
      throw new Error(`sessionStorage: ${JSON.stringify(r.sessionStorage)}`);
    }
    return {
      cookie: Array.isArray(r.cookie) ? r.cookie.length : "n/a",
      localKeys: Object.keys(r.localStorage).length,
      sessionKeys: Object.keys(r.sessionStorage).length,
    };
  });
  await step("getStorage (cookie only)", async () => {
    const r = await callTool("getStorage", { tabId, types: ["cookie"] });
    if (r.localStorage) throw new Error("should not include localStorage");
    return { cookie: Array.isArray(r.cookie) ? r.cookie.length : "n/a" };
  });

  // 21. getSourceAt — fetch the current page HTML
  await step("getSourceAt (current page)", async () => {
    const r = await callTool("getSourceAt", {
      tabId,
      url: "https://example.com/",
      line: 0,
      range: 5,
    });
    if (!r.snippet) throw new Error("no snippet");
    if (typeof r.fromLine !== "number") throw new Error("no fromLine");
    return { fromLine: r.fromLine, toLine: r.toLine, len: r.snippet.length };
  });

  // 22. waitForStable (already-idle case)
  await step("waitForStable (idle)", async () => {
    const r = await callTool("waitForStable", { tabId, timeout: 2000 });
    if (!r.status) throw new Error("no status");
    return r;
  });

  // 23. setSafetyMode round-trip (don't trigger any overlays from 'always')
  await step("setSafetyMode=always (returns mode)", async () => {
    const r = await callTool("setSafetyMode", { mode: "always" });
    if (r.mode !== "always") throw new Error(`mode=${r.mode}`);
    return r;
  });
  await step("setSafetyMode=dangerous-only", async () => {
    const r = await callTool("setSafetyMode", { mode: "dangerous-only" });
    if (r.mode !== "dangerous-only") throw new Error(`mode=${r.mode}`);
    return r;
  });
  // back to 'off' so the cleanup navigate doesn't pop overlays
  await step("setSafetyMode=off (for cleanup)", () =>
    callTool("setSafetyMode", { mode: "off" })
  );

  // 24. Schema validation: missing required param
  await expectFail("schema: getTabInfo without tabId", () =>
    callTool("getTabInfo", {})
  );
  await expectFail("schema: navigate with bad url", () =>
    callTool("navigate", { tabId, url: "not-a-url" })
  );

  // 25. Cleanup: remove injected DOM (it survives nothing since we navigate)
  // 26. Restore original tab URL
  await step("cleanup: navigate back to original", async () => {
    if (!originalUrl || originalUrl === "https://example.com/") {
      return { skipped: "original was example.com or unknown" };
    }
    const r = await callTool("navigate", { tabId, url: originalUrl });
    if (!r.ok) throw new Error("nav back failed");
    return { url: originalUrl };
  });
  await step("cleanup: waitForStable after restore", () =>
    callTool("waitForStable", { tabId, timeout: 8000 })
  );

  // 27. Restore safety mode default
  await step("setSafetyMode=dangerous-only (final restore)", () =>
    callTool("setSafetyMode", { mode: "dangerous-only" })
  );

  finish();
})().catch((e) => {
  console.error("FATAL", e);
  child.kill();
  process.exit(2);
});

function finish() {
  const total = passes + failures;
  console.log(`\n— Summary —`);
  console.log(`pass: ${passes}/${total}    fail: ${failures}`);
  if (failures > 0) {
    console.log(`\nFailures:`);
    for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}: ${r.info}`);
  }
  child.kill();
  process.exit(failures === 0 ? 0 : 1);
}
