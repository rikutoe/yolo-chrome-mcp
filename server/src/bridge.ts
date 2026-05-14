import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { WireMessage, RpcRequest } from "./wire.js";

// Single-client WebSocket hub. The extension connects here; the MCP server
// uses call() to dispatch JSON-RPC-ish requests to it.
export class ExtensionBridge {
  private wss: WebSocketServer;
  private socket: WebSocket | null = null;
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(port: number) {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port });
    this.wss.on("connection", (ws) => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        // Replace stale connection. Last writer wins.
        try {
          this.socket.close();
        } catch {}
      }
      this.socket = ws;
      ws.on("message", (raw) => this.onMessage(String(raw)));
      ws.on("close", () => {
        if (this.socket === ws) this.socket = null;
        this.failAllPending(new Error("extension disconnected"));
      });
      ws.on("error", () => {
        /* ignore — handled by close */
      });
    });
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  call<T = any>(method: string, params: any = {}, timeoutMs = 15000): Promise<T> {
    if (!this.isConnected()) {
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
      this.socket!.send(JSON.stringify(msg));
    });
  }

  private onMessage(raw: string) {
    let msg: WireMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "rpc-result") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
    // Events are ignored at this layer for now — extension keeps its own buffers.
  }

  private failAllPending(err: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
