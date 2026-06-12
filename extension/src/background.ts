import type { RpcResponse } from "./wire.js";
import * as h from "./handlers.js";

const WS_URL = "ws://127.0.0.1:8765/";
let socket: WebSocket | null = null;
let reconnectTimer: any = null;
// True when another Chrome profile has taken over the single MCP connection.
// While suppressed we stop auto-reconnecting (otherwise the two profiles fight
// over the one socket forever). Cleared only when the user explicitly claims
// the connection from this profile's popup. Persisted so it survives the MV3
// service worker going dormant / the browser restarting.
let suppressed = false;
// True when the user pinned THIS profile ("このブラウザに固定"). A pinned profile
// holds the connection no matter which window is focused, and fights back if
// evicted by anything other than another pin. Persisted across SW restarts.
let pinned = false;

const handlers: Record<string, (params: any) => Promise<any>> = {
  listTabs: () => h.listTabs(),
  getTabInfo: (p) => h.getTabInfo(p),
  screenshot: (p) => h.screenshot(p),
  getPageText: (p) => h.getPageText(p),
  getInteractables: (p) => h.getInteractables(p),
  getConsoleLogs: (p) => h.getConsoleLogs(p),
  getNetworkActivity: (p) => h.getNetworkActivity(p),
  getNetworkRequest: (p) => h.getNetworkRequest(p),
  getStorage: (p) => h.getStorage(p),
  getSourceAt: (p) => h.getSourceAt(p),
  click: (p) => h.click(p),
  clickByLabel: (p) => h.clickByLabel(p),
  type: (p) => h.typeText(p),
  scroll: (p) => h.scroll(p),
  navigate: (p) => h.navigate(p),
  createTab: (p) => h.createTab(p),
  closeTab: (p) => h.closeTab(p),
  evalJs: (p) => h.evalJs(p),
  waitForStable: (p) => h.waitForStable(p),
  setSafetyMode: (p) => h.setSafetyMode(p),
  reloadSelf: () => h.reloadSelf(),
};

function connect(userInitiated = false) {
  // The user explicitly asked to connect here → drop any dormant state and
  // take over the connection from whichever profile currently holds it.
  if (userInitiated) setSuppressed(false);
  if (suppressed) return;
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  try {
    socket = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  socket.addEventListener("open", () => {
    console.log("[yolo] connected to MCP server");
    setBadge("on");
    sendHello();
  });
  socket.addEventListener("close", () => {
    setBadge(suppressed ? "idle" : "off");
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    setBadge(suppressed ? "idle" : "off");
  });
  socket.addEventListener("message", async (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    // Server is handing our connection to another profile.
    if (msg?.type === "evicted") {
      try {
        socket?.close();
      } catch {}
      if (msg.reason === "pinned") {
        // Another profile is pinned. Stand down completely — don't reclaim even
        // if focused, and drop our own pin (we lost it).
        setPinned(false);
        setSuppressed(true);
        setBadge("idle");
        return;
      }
      // Normal takeover: go dormant, but reclaim immediately if WE are pinned
      // (stay put regardless of focus) or the user is currently looking at us.
      setSuppressed(true);
      setBadge("idle");
      if (pinned) {
        connect(true);
      } else {
        void isProfileFocused().then((focused) => {
          if (focused) connect(true);
        });
      }
      return;
    }
    if (msg.type !== "rpc") return;
    const reply: RpcResponse = { type: "rpc-result", id: msg.id };
    const handler = handlers[msg.method];
    if (!handler) {
      reply.error = { message: `unknown method: ${msg.method}` };
    } else {
      try {
        reply.result = await handler(msg.params ?? {});
      } catch (e: any) {
        reply.error = { message: e?.message ?? String(e) };
      }
    }
    try {
      socket?.send(JSON.stringify(reply));
    } catch {}
  });
}

function scheduleReconnect() {
  if (suppressed) return; // a peer profile owns the connection; stay dormant
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function setSuppressed(value: boolean) {
  suppressed = value;
  void chrome.storage.local.set({ suppressed: value });
}

function setPinned(value: boolean) {
  pinned = value;
  void chrome.storage.local.set({ pinned: value });
}

// The connected profile is named by its signed-in Chrome account email, so the
// AI can tell the user "you're connected to <email>". Chrome exposes no API for
// the human profile name ("Work"/"Personal"), but the account email distinguishes
// profiles and is meaningful to the user.
async function getAccountEmail(): Promise<string> {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    return info?.email ?? "";
  } catch {
    return "";
  }
}

async function sendHello() {
  const label = await getAccountEmail();
  try {
    socket?.send(JSON.stringify({ type: "hello", label, pin: pinned }));
  } catch {}
}

function setBadge(state: "on" | "off" | "idle") {
  const text = state === "on" ? "ON" : state === "idle" ? "··" : "";
  const color = state === "on" ? "#16a34a" : state === "idle" ? "#9ca3af" : "#dc2626";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// Boot: restore dormant state before attempting a connection, so a profile that
// was taken over previously doesn't immediately rejoin the fight on SW wake.
// If the user is currently looking at this profile, claim the connection.
async function boot() {
  h.loadSafetyMode();
  const stored = await chrome.storage.local.get(["suppressed", "pinned"]);
  pinned = !!stored.pinned;
  // A pinned profile always reclaims on boot; otherwise honor dormant state.
  suppressed = pinned ? false : !!stored.suppressed;
  setBadge(suppressed ? "idle" : "off");
  connect(pinned || (await isProfileFocused()));
}

async function isProfileFocused(): Promise<boolean> {
  try {
    const w = await chrome.windows.getLastFocused();
    return !!w?.focused;
  } catch {
    return false;
  }
}
void boot();

// MV3 service workers go dormant after ~30s of inactivity. A periodic alarm
// is the documented way to keep the WS connection lifecycle responsive: each
// alarm fire wakes the SW, which re-runs module init (which calls connect()
// again if the socket is gone).
chrome.alarms.create("yolo-keepalive", { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "yolo-keepalive") {
    if (!suppressed && (!socket || socket.readyState !== WebSocket.OPEN)) connect();
  }
});
chrome.runtime.onStartup.addListener(() => void boot());
chrome.runtime.onInstalled.addListener(() => void boot());

// The profile the user is actively looking at should own the single connection.
// Focusing any window of this profile claims it; the server then evicts whichever
// other profile held it, and that one goes dormant instead of fighting back.
// (A profile that holds the connection while unfocused — e.g. you're driving it
// from a terminal — keeps it; nothing steals it until another profile is focused.)
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  connect(true);
});

// Popup polls status.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === "status") {
    // Email lookup is async; keep the message channel open (return true).
    void getAccountEmail().then((email) => {
      sendResponse({
        connected: socket?.readyState === WebSocket.OPEN,
        suppressed,
        pinned,
        email,
      });
    });
    return true;
  }
  if (msg?.type === "setPin") {
    // Popup pin toggle. Pinning claims+locks this profile; unpinning just
    // releases the lock and lets focus-follow resume.
    const value = !!msg.pinned;
    setPinned(value);
    if (value) {
      connect(true); // claim and lock (hello carries pin:true)
    } else if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "pin", pinned: false }));
      } catch {}
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "reconnect") {
    // Popup "connect here" → claim the connection for this profile.
    try {
      socket?.close();
    } catch {}
    connect(true);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
