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
