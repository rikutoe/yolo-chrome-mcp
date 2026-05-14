// Tiny typed wrapper around chrome.debugger.

export type CdpTarget = chrome.debugger.Debuggee;

const PROTO_VERSION = "1.3";

export async function attach(tabId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, PROTO_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err && !/already attached/i.test(err.message)) {
        return reject(new Error(err.message));
      }
      resolve();
    });
  });
}

export async function detach(tabId: number): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      // Ignore "not attached" errors.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

export function send<T = any>(tabId: number, method: string, params?: any): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(`${method}: ${err.message}`));
      resolve(result as T);
    });
  });
}
