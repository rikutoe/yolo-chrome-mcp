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

export type WireMessage = RpcRequest | RpcResponse;

export const RING_LIMITS = { console: 500, network: 500 } as const;
export const DEFAULTS = {
  consoleRecent: 20,
  networkRecent: 20,
  pageTextChars: 2000,
  sourceContextLines: 10,
  waitStableMs: 5000,
} as const;
