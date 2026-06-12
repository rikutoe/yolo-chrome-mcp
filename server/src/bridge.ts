import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { WireMessage, RpcRequest } from "./wire.js";

// yolo-chrome-mcp can have multiple Claude Code sessions running concurrently.
// Each session spawns its own MCP server process. Only ONE process can own the
// extension WS port (8765). The others run as "secondaries" and forward RPC
// calls to the primary via a sibling-IPC WS port (default 8766).
//
//   Primary  (8765 ← extension, 8766 ← secondaries)
//      │
//      └─ forwards each secondary call to the extension, fans the result back
//         to the originating secondary.
//
// If the primary dies, secondaries detect the IPC drop and try to promote
// themselves by re-binding 8765. The winner becomes the new primary; the rest
// stay secondaries and reconnect to it.

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

type Role = "primary" | "secondary" | "starting";

export class ExtensionBridge {
  private extensionPort: number;
  private siblingPort: number;
  private role: Role = "starting";

  // Primary-only state.
  private extWss: WebSocketServer | null = null;
  private extSocket: WebSocket | null = null;
  /** Label of the currently connected extension's Chrome profile ("" if unset). */
  private extLabel: string | null = null;
  /** When true, the current holder is pinned and refuses non-pin takeovers. */
  private extPinned = false;
  private siblingWss: WebSocketServer | null = null;
  /** secondaryConnId → its socket */
  private siblingSockets = new Map<string, WebSocket>();
  /** internalId → { siblingConnId, siblingReqId } so we can route results back */
  private siblingRouting = new Map<
    string,
    { connId: string; reqId: string }
  >();

  // Secondary-only state.
  private siblingClient: WebSocket | null = null;
  private siblingClientReady: Promise<void> | null = null;
  /** Profile label learned from the primary (secondary doesn't own the socket). */
  private cachedLabel: string | null = null;

  // Shared state: pending local calls (only used in primary).
  private pending = new Map<string, Pending>();

  constructor(extensionPort: number, siblingPort?: number) {
    this.extensionPort = extensionPort;
    this.siblingPort = siblingPort ?? extensionPort + 1;
    // Kick off init asynchronously; call() awaits readiness.
    void this.init();
  }

  // ---- role-aware setup --------------------------------------------------

  private async init(): Promise<void> {
    while (true) {
      const bound = await this.tryBindPrimary();
      if (bound) {
        this.role = "primary";
        process.stderr.write(
          `yolo-chrome-mcp: primary on ws://127.0.0.1:${this.extensionPort} (sibling ipc :${this.siblingPort})\n`
        );
        return;
      }
      // Someone else owns :extensionPort. Become a secondary.
      try {
        await this.connectAsSecondary();
        this.role = "secondary";
        process.stderr.write(
          `yolo-chrome-mcp: secondary, relaying via ws://127.0.0.1:${this.siblingPort}\n`
        );
        return;
      } catch {
        // Primary not ready yet (it may still be binding :siblingPort). Loop.
        await sleep(150);
      }
    }
  }

  private tryBindPrimary(): Promise<boolean> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: this.extensionPort });
      wss.once("error", (err: any) => {
        if (err?.code === "EADDRINUSE") {
          resolve(false);
        } else {
          process.stderr.write(`yolo-chrome-mcp: primary bind error: ${err?.message}\n`);
          resolve(false);
        }
      });
      wss.once("listening", () => {
        this.extWss = wss;
        this.attachExtensionHandlers();
        this.startSiblingServer();
        resolve(true);
      });
    });
  }

  private attachExtensionHandlers(): void {
    if (!this.extWss) return;
    this.extWss.on("connection", (ws) => {
      // Don't evict the current holder yet — the newcomer must identify itself
      // via `hello` first, so a *pinned* holder can refuse a non-pin takeover.
      ws.on("message", (raw) => this.onExtensionMessage(ws, String(raw)));
      ws.on("close", () => {
        // Only the active holder closing matters; a refused newcomer is a no-op.
        if (this.extSocket === ws) {
          this.extSocket = null;
          this.extLabel = null;
          this.extPinned = false;
          this.broadcastLabel();
          this.failAllPending(new Error("extension disconnected"));
        }
      });
      ws.on("error", () => {
        /* handled via close */
      });
    });
  }

  /**
   * A newcomer announced itself. Decide whether it takes over the single
   * connection. A pinned holder refuses any non-pin claim; a pin claim
   * overrides anything (including another pin).
   */
  private handleHello(ws: WebSocket, pin: boolean, label: string): void {
    const holder = this.extSocket;
    const holderActive =
      !!holder && holder !== ws && holder.readyState === WebSocket.OPEN;

    if (holderActive && this.extPinned && !pin) {
      // Pinned elsewhere and this isn't a pin override → deny the newcomer.
      try {
        ws.send(JSON.stringify({ type: "evicted", reason: "pinned" }));
      } catch {}
      try {
        ws.close();
      } catch {}
      return;
    }

    if (holderActive) {
      // Newcomer wins. If it's a pin, the loser must stay down (reason "pinned").
      try {
        holder!.send(
          JSON.stringify(pin ? { type: "evicted", reason: "pinned" } : { type: "evicted" })
        );
      } catch {}
      try {
        holder!.close();
      } catch {}
      this.failAllPending(new Error("extension connection changed"));
    }
    this.extSocket = ws;
    this.extLabel = label;
    this.extPinned = pin;
    this.broadcastLabel();
  }

  private startSiblingServer(): void {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: this.siblingPort });
    wss.on("connection", (ws) => {
      const connId = randomUUID();
      this.siblingSockets.set(connId, ws);
      // Catch the new secondary up on the current profile label.
      try {
        ws.send(JSON.stringify({ type: "label", label: this.extLabel ?? "" }));
      } catch {}
      ws.on("message", (raw) => this.onSiblingMessage(connId, String(raw)));
      ws.on("close", () => {
        this.siblingSockets.delete(connId);
        // Drop pending routing entries owned by this sibling.
        for (const [iid, route] of this.siblingRouting) {
          if (route.connId === connId) this.siblingRouting.delete(iid);
        }
      });
      ws.on("error", () => {
        /* handled via close */
      });
    });
    wss.on("error", (err) => {
      process.stderr.write(`yolo-chrome-mcp: sibling server error: ${err.message}\n`);
    });
    this.siblingWss = wss;
  }

  private async connectAsSecondary(): Promise<void> {
    const url = `ws://127.0.0.1:${this.siblingPort}`;
    const ws = new WebSocket(url);
    this.siblingClient = ws;
    this.siblingClientReady = new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onErr = (e: any) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onErr);
      };
      ws.on("open", onOpen);
      ws.on("error", onErr);
    });
    await this.siblingClientReady;

    ws.on("message", (raw) => this.onSiblingClientMessage(String(raw)));
    ws.on("close", () => {
      this.siblingClient = null;
      this.failAllPending(new Error("sibling primary disconnected"));
      // Attempt promotion.
      this.role = "starting";
      void this.init();
    });
    ws.on("error", () => {
      /* handled via close */
    });
  }

  // ---- public API --------------------------------------------------------

  isConnected(): boolean {
    if (this.role === "primary") {
      return this.extSocket?.readyState === WebSocket.OPEN;
    }
    if (this.role === "secondary") {
      return this.siblingClient?.readyState === WebSocket.OPEN;
    }
    return false;
  }

  async call<T = any>(method: string, params: any = {}, timeoutMs = 15000): Promise<T> {
    // Wait briefly for init to settle if we are still starting up.
    if (this.role === "starting") {
      await waitFor(() => this.role !== "starting", 3000);
    }

    if (this.role === "primary") {
      return this.callAsPrimary<T>(method, params, timeoutMs);
    }
    if (this.role === "secondary") {
      return this.callAsSecondary<T>(method, params, timeoutMs);
    }
    throw new Error("yolo-chrome-mcp: bridge not ready");
  }

  // ---- primary impl ------------------------------------------------------

  private callAsPrimary<T>(method: string, params: any, timeoutMs: number): Promise<T> {
    if (!this.extSocket || this.extSocket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(
          "Chrome extension is not connected. Install the extension from extension/dist and reload, then retry."
        )
      );
    }
    const id = randomUUID();
    const msg: RpcRequest = { type: "rpc", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`extension call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.extSocket!.send(JSON.stringify(msg));
    });
  }

  private onExtensionMessage(ws: WebSocket, raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      this.handleHello(ws, !!msg.pin, msg.label ?? "");
      return;
    }
    if (msg.type === "pin") {
      // The current holder toggled its pin state.
      if (ws === this.extSocket) this.extPinned = !!msg.pinned;
      return;
    }
    if (msg.type !== "rpc-result") return;
    if (ws !== this.extSocket) return; // ignore stragglers from a refused socket

    // Result from a sibling's request?
    const route = this.siblingRouting.get(msg.id);
    if (route) {
      this.siblingRouting.delete(msg.id);
      const sibling = this.siblingSockets.get(route.connId);
      if (sibling && sibling.readyState === WebSocket.OPEN) {
        sibling.send(
          JSON.stringify({
            type: "rpc-result",
            id: route.reqId,
            result: msg.result,
            error: msg.error,
          })
        );
      }
      return;
    }

    // Result from a local (primary's own) request.
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  private onSiblingMessage(connId: string, raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.type !== "rpc") return;
    if (!this.extSocket || this.extSocket.readyState !== WebSocket.OPEN) {
      // Reply with error.
      const sock = this.siblingSockets.get(connId);
      sock?.send(
        JSON.stringify({
          type: "rpc-result",
          id: msg.id,
          error: { message: "Chrome extension is not connected." },
        })
      );
      return;
    }
    const internalId = randomUUID();
    this.siblingRouting.set(internalId, { connId, reqId: msg.id });
    this.extSocket.send(
      JSON.stringify({ type: "rpc", id: internalId, method: msg.method, params: msg.params })
    );
  }

  // ---- secondary impl ----------------------------------------------------

  private callAsSecondary<T>(method: string, params: any, timeoutMs: number): Promise<T> {
    if (!this.siblingClient || this.siblingClient.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("yolo-chrome-mcp: sibling primary not connected"));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`extension call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.siblingClient!.send(JSON.stringify({ type: "rpc", id, method, params }));
    });
  }

  private onSiblingClientMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.type === "label") {
      this.cachedLabel = msg.label ?? "";
      return;
    }
    if (msg?.type !== "rpc-result") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }

  // ---- shared ------------------------------------------------------------

  /**
   * Label of the Chrome profile currently driving the extension, or null when
   * no extension is connected. Empty string means connected but unnamed.
   */
  getProfileLabel(): string | null {
    if (this.role === "primary") {
      return this.extSocket?.readyState === WebSocket.OPEN ? this.extLabel ?? "" : null;
    }
    if (this.role === "secondary") {
      return this.siblingClient?.readyState === WebSocket.OPEN ? this.cachedLabel : null;
    }
    return null;
  }

  private broadcastLabel(): void {
    const payload = JSON.stringify({ type: "label", label: this.extLabel ?? "" });
    for (const [, sock] of this.siblingSockets) {
      if (sock.readyState === WebSocket.OPEN) {
        try {
          sock.send(payload);
        } catch {}
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return;
    await sleep(50);
  }
}
