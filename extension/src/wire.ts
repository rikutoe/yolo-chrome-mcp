// Inline wire types — copied from shared so the extension build has no deps on workspaces.
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

// Sent by the extension right after the WS opens, identifying which Chrome
// profile this connection belongs to (user-set label, "" if unset).
export interface HelloMessage {
  type: "hello";
  label: string;
  /** When true, this profile is pinned: it refuses to be taken over by focus. */
  pin?: boolean;
}

// Sent by the server to an extension whose connection is being taken over by
// another profile. The evicted extension goes dormant (stops auto-reconnecting)
// until the user explicitly claims the connection from its popup. `reason:
// "pinned"` means another profile is pinned — don't auto-reclaim, even if focused.
export interface EvictedMessage {
  type: "evicted";
  reason?: "pinned";
}

// Sent by the current holder to toggle its pinned state without reconnecting.
export interface PinMessage {
  type: "pin";
  pinned: boolean;
}

// Primary → secondary MCP servers: the current connected profile label.
export interface LabelMessage {
  type: "label";
  label: string;
}

export type WireMessage =
  | RpcRequest
  | RpcResponse
  | HelloMessage
  | EvictedMessage
  | PinMessage
  | LabelMessage;

export const RING_LIMITS = { console: 500, network: 500 } as const;
export const DEFAULTS = {
  consoleRecent: 20,
  networkRecent: 20,
  pageTextChars: 2000,
  sourceContextLines: 10,
  waitStableMs: 5000,
} as const;
