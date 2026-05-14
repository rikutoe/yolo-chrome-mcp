// Content script — renders a confirmation banner and resolves yes/no.
// Re-injected on demand by overlayBridge.

declare const chrome: any;

(() => {
  if ((globalThis as any).__yoloOverlayInstalled) return;
  (globalThis as any).__yoloOverlayInstalled = true;

  chrome.runtime.onMessage.addListener(
    (msg: any, _sender: any, sendResponse: (r: any) => void) => {
      if (msg?.type !== "yolo-confirm") return false;
      render(msg.action, msg.details, (allowed: boolean) => sendResponse({ allowed }));
      return true; // keep channel open for async response
    }
  );

  function render(action: string, details: any, done: (allowed: boolean) => void) {
    const existing = document.getElementById("yolo-confirm-root");
    if (existing) existing.remove();

    const root = document.createElement("div");
    root.id = "yolo-confirm-root";
    root.attachShadow({ mode: "open" });
    const css = `
      .wrap{position:fixed;top:16px;right:16px;z-index:2147483647;font-family:-apple-system,system-ui,sans-serif;color:#111;background:#fffaf0;border:2px solid #d97706;border-radius:10px;padding:14px 16px;width:340px;box-shadow:0 12px 32px rgba(0,0,0,0.2);}
      h3{margin:0 0 6px;font-size:14px;font-weight:600;color:#b45309}
      pre{margin:6px 0 10px;font-size:12px;color:#333;white-space:pre-wrap;word-break:break-word;background:#fdf6e3;padding:6px 8px;border-radius:6px;max-height:160px;overflow:auto}
      .row{display:flex;gap:8px;justify-content:flex-end}
      button{padding:6px 12px;border-radius:6px;border:0;font-size:13px;font-weight:600;cursor:pointer}
      .allow{background:#16a34a;color:#fff}
      .deny{background:#dc2626;color:#fff}
    `;
    const html = `
      <div class="wrap">
        <h3>AIが操作しようとしています: ${escape(action)}</h3>
        <pre>${escape(JSON.stringify(details, null, 2))}</pre>
        <div class="row">
          <button class="deny">拒否</button>
          <button class="allow">許可</button>
        </div>
      </div>
    `;
    const style = document.createElement("style");
    style.textContent = css;
    const container = document.createElement("div");
    container.innerHTML = html;
    root.shadowRoot!.appendChild(style);
    root.shadowRoot!.appendChild(container);
    document.documentElement.appendChild(root);

    const allow = root.shadowRoot!.querySelector(".allow") as HTMLButtonElement;
    const deny = root.shadowRoot!.querySelector(".deny") as HTMLButtonElement;
    const cleanup = (result: boolean) => {
      root.remove();
      done(result);
    };
    allow.addEventListener("click", () => cleanup(true));
    deny.addEventListener("click", () => cleanup(false));
  }

  function escape(s: string) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
