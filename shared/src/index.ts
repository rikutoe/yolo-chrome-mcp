// Wire protocol between MCP server (WS hub) and Chrome extension.
// All messages are JSON over a single WebSocket. Extension is the client.

export type SafetyMode = "always" | "dangerous-only" | "off";

export interface RpcRequest {
  type: "rpc";
  id: string;
  method: string;
  params: any;
}

export interface RpcResponse {
  type: "rpc-result";
  id: string;
  result?: any;
  error?: { message: string; code?: string };
}

export interface RpcEvent {
  type: "event";
  event: string;
  data: any;
}

export type WireMessage = RpcRequest | RpcResponse | RpcEvent;

// Ring buffer sizes used by the extension
export const RING_LIMITS = {
  console: 500,
  network: 500,
} as const;

// Default response limits
export const DEFAULTS = {
  consoleRecent: 20,
  networkRecent: 20,
  pageTextChars: 2000,
  sourceContextLines: 10,
  waitStableMs: 5000,
} as const;
