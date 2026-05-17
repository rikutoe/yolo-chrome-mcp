const dot = document.getElementById("dot")!;
const text = document.getElementById("text")!;
const sub = document.getElementById("sub")!;
const reconnect = document.getElementById("reconnect")!;
const modeHint = document.getElementById("modeHint")!;
const versionEl = document.getElementById("version")!;
const setupCard = document.getElementById("setupCard")! as HTMLDivElement;
const cmdBlock = document.getElementById("cmdBlock")! as HTMLPreElement;
const copyCmd = document.getElementById("copyCmd")!;
const copyLabel = document.getElementById("copyLabel")!;

const safetyInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="safety"]')
);

const HINTS: Record<string, string> = {
  always: "すべての操作で確認ダイアログを出します。",
  "dangerous-only":
    "決済・退会・パスワード送信・危険な evalJs のみ確認します。",
  off: "確認なしですべて自動実行します。注意して使ってください。",
};

function setConnected(connected: boolean, subtext: string) {
  dot.className = connected ? "dot on" : "dot";
  text.textContent = connected ? "接続中" : "未接続";
  sub.textContent = subtext;
  setupCard.hidden = connected;
}

async function refresh() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "status" });
    setConnected(
      !!r?.connected,
      r?.connected ? "MCP サーバと通信できます" : "下のコマンドでセットアップしてください"
    );
  } catch {
    setConnected(false, "拡張機能をリロードしてください");
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

  copyCmd.addEventListener("click", async () => {
    const cmd = cmdBlock.textContent ?? "";
    try {
      await navigator.clipboard.writeText(cmd);
      copyLabel.textContent = "コピーしました";
    } catch {
      copyLabel.textContent = "コピー失敗";
    }
    setTimeout(() => {
      copyLabel.textContent = "コマンドをコピー";
    }, 1500);
  });

  refresh();
  setInterval(refresh, 1500);
})();
