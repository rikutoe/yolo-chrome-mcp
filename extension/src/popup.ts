const dot = document.getElementById("dot")!;
const text = document.getElementById("text")!;
const sub = document.getElementById("sub")!;
const reconnect = document.getElementById("reconnect")!;
const modeHint = document.getElementById("modeHint")!;
const versionEl = document.getElementById("version")!;

const safetyInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="safety"]')
);

const HINTS: Record<string, string> = {
  always: "すべての操作で確認ダイアログを出します。",
  "dangerous-only":
    "決済・退会・パスワード送信・危険な evalJs のみ確認します。",
  off: "確認なしですべて自動実行します。注意して使ってください。",
};

async function refresh() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "status" });
    if (r?.connected) {
      dot.className = "dot on";
      text.textContent = "接続中";
      sub.textContent = "MCP サーバと通信できます";
    } else {
      dot.className = "dot";
      text.textContent = "未接続";
      sub.textContent = "MCP サーバを起動してください";
    }
  } catch {
    dot.className = "dot";
    text.textContent = "未接続";
    sub.textContent = "拡張機能をリロードしてください";
  }
}

function setHint(mode: string) {
  modeHint.textContent = HINTS[mode] ?? "";
}

(async () => {
  try {
    const manifest = chrome.runtime.getManifest();
    versionEl.textContent = `v${manifest.version}`;
  } catch {
    /* noop */
  }

  const v = await chrome.storage.local.get("safetyMode");
  const current = (v.safetyMode as string) ?? "dangerous-only";
  for (const input of safetyInputs) {
    input.checked = input.value === current;
  }
  setHint(current);

  for (const input of safetyInputs) {
    input.addEventListener("change", async () => {
      if (!input.checked) return;
      const mode = input.value;
      setHint(mode);
      await chrome.storage.local.set({ safetyMode: mode });
      await chrome.runtime.sendMessage({
        type: "rpc",
        id: "popup-" + Date.now(),
        method: "setSafetyMode",
        params: { mode },
      });
    });
  }

  reconnect.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "reconnect" });
    refresh();
  });

  refresh();
  setInterval(refresh, 1500);
})();
