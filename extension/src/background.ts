import type { RpcRequest, RpcResponse } from "./wire.js";
import * as h from "./handlers.js";

const WS_URL = "ws://127.0.0.1:8765/";
let socket: WebSocket | null = null;
let reconnectTimer: any = null;

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
  type: (p) => h.typeText(p),
  scroll: (p) => h.scroll(p),
  navigate: (p) => h.navigate(p),
  evalJs: (p) => h.evalJs(p),
  waitForStable: (p) => h.waitForStable(p),
  setSafetyMode: (p) => h.setSafetyMode(p),
};

function connect() {
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
  });
  socket.addEventListener("close", () => {
    setBadge("off");
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    setBadge("off");
  });
  socket.addEventListener("message", async (ev) => {
    let msg: RpcRequest;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
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
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function setBadge(state: "on" | "off") {
  chrome.action.setBadgeText({ text: state === "on" ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: state === "on" ? "#16a34a" : "#dc2626" });
}

// Boot
h.loadSafetyMode();
connect();

// MV3 service workers go dormant after ~30s of inactivity. A periodic alarm
// is the documented way to keep the WS connection lifecycle responsive: each
// alarm fire wakes the SW, which re-runs module init (which calls connect()
// again if the socket is gone).
chrome.alarms.create("yolo-keepalive", { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "yolo-keepalive") {
    if (!socket || socket.readyState !== WebSocket.OPEN) connect();
  }
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Popup polls status.
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === "status") {
    sendResponse({ connected: socket?.readyState === WebSocket.OPEN });
    return false;
  }
  if (msg?.type === "reconnect") {
    try {
      socket?.close();
    } catch {}
    connect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
