import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["extension/src/reconnect.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const source = result.outputFiles[0].text;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { ReconnectScheduler } = await import(moduleUrl);

function createHarness() {
  const pending = new Map();
  const delays = [];
  let nextId = 1;
  let connects = 0;
  const scheduler = new ReconnectScheduler(
    () => connects++,
    (callback, delayMs) => {
      const id = nextId++;
      delays.push(delayMs);
      pending.set(id, callback);
      return id;
    },
    (id) => pending.delete(id),
  );
  return {
    scheduler,
    delays,
    pending,
    connects: () => connects,
    fireNext() {
      const [id, callback] = pending.entries().next().value;
      pending.delete(id);
      callback();
    },
  };
}

test("failed reconnects back off to 60 seconds without overlapping timers", () => {
  const h = createHarness();
  for (const expected of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
    assert.equal(h.scheduler.schedule(), true);
    assert.equal(h.scheduler.schedule(), false);
    assert.equal(h.pending.size, 1);
    assert.equal(h.delays.at(-1), expected);
    h.fireNext();
  }
  assert.equal(h.connects(), 7);
});

test("a successful or user-initiated connection resets the retry delay", () => {
  const h = createHarness();
  h.scheduler.schedule();
  h.fireNext();
  h.scheduler.schedule();
  assert.equal(h.delays.at(-1), 4_000);

  h.scheduler.reset();
  assert.equal(h.pending.size, 0);
  h.scheduler.schedule();
  assert.equal(h.delays.at(-1), 2_000);
});

test("background lifecycle resets, suppresses, and deduplicates reconnects", async () => {
  const original = {
    chrome: globalThis.chrome,
    WebSocket: globalThis.WebSocket,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const pending = new Map();
  const delays = [];
  const listeners = {};
  const sockets = [];
  let nextTimerId = 1;
  let resolveRestore;
  const restoredState = new Promise((resolve) => (resolveRestore = resolve));
  const flushAsyncWork = () => new Promise((resolve) => setImmediate(resolve));

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      sockets.push(this);
    }

    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }

    emit(name, data) {
      if (name === "open") this.readyState = FakeWebSocket.OPEN;
      if (name === "close") this.readyState = FakeWebSocket.CLOSED;
      this.listeners.get(name)?.(data);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSING;
    }

    send() {}
  }

  const storage = {};
  globalThis.WebSocket = FakeWebSocket;
  globalThis.setTimeout = (callback, delayMs) => {
    const id = nextTimerId++;
    delays.push(delayMs);
    pending.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = (id) => pending.delete(id);
  globalThis.chrome = {
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
    },
    alarms: {
      create(name, options) {
        listeners.alarmConfig = { name, options };
      },
      onAlarm: { addListener: (callback) => (listeners.alarm = callback) },
    },
    identity: { getProfileUserInfo: async () => ({ email: "" }) },
    runtime: {
      onInstalled: { addListener: (callback) => (listeners.installed = callback) },
      onMessage: { addListener: (callback) => (listeners.message = callback) },
      onStartup: { addListener: (callback) => (listeners.startup = callback) },
    },
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          if (names.includes("suppressed")) return restoredState;
          return Object.fromEntries(names.map((key) => [key, storage[key]]));
        },
        async set(values) {
          Object.assign(storage, values);
        },
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: async () => ({ focused: false }),
      onFocusChanged: {
        addListener: (callback) => (listeners.focusChanged = callback),
      },
    },
  };

  try {
    const background = await build({
      entryPoints: ["extension/src/background.ts"],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    });
    const backgroundUrl = `data:text/javascript;base64,${Buffer.from(background.outputFiles[0].text).toString("base64")}#${Date.now()}`;
    await import(backgroundUrl);
    await Promise.resolve();

    assert.deepEqual(listeners.alarmConfig, {
      name: "yolo-keepalive",
      options: { periodInMinutes: 1 },
    });
    assert.equal(sockets.length, 0);
    listeners.alarm({ name: "yolo-keepalive" });
    assert.equal(sockets.length, 0, "alarm must wait for stored ownership state");
    resolveRestore({ suppressed: true, pinned: false });
    await flushAsyncWork();
    assert.equal(sockets.length, 0, "stored suppression must prevent reconnect");

    listeners.message({ type: "reconnect" }, {}, () => {});
    await flushAsyncWork();
    assert.equal(sockets.length, 1, "manual reconnect must reclaim the profile");

    sockets[0].emit("close");
    assert.equal(delays.at(-1), 2_000);
    assert.equal(pending.size, 1);
    listeners.alarm({ name: "yolo-keepalive" });
    assert.equal(sockets.length, 1, "alarm must not overlap a pending retry");

    listeners.focusChanged(1);
    await flushAsyncWork();
    assert.equal(pending.size, 0, "focus must cancel the pending retry");
    assert.equal(sockets.length, 2);
    sockets[1].emit("open");
    sockets[1].emit("close");
    assert.equal(delays.at(-1), 2_000, "successful open must reset backoff");

    sockets[1].emit("message", {
      data: JSON.stringify({ type: "evicted", reason: "pinned" }),
    });
    assert.equal(pending.size, 0, "peer ownership must cancel retries");
    listeners.alarm({ name: "yolo-keepalive" });
    assert.equal(sockets.length, 2, "suppressed profile must stay dormant");

    listeners.message({ type: "reconnect" }, {}, () => {});
    await flushAsyncWork();
    assert.equal(sockets.length, 3, "manual reconnect must reclaim the profile");
  } finally {
    globalThis.chrome = original.chrome;
    globalThis.WebSocket = original.WebSocket;
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
  }
});
