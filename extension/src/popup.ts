const dot = document.getElementById("dot")!;
const text = document.getElementById("text")!;
const safety = document.getElementById("safety") as HTMLSelectElement;
const reconnect = document.getElementById("reconnect")!;

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: "status" });
  if (r?.connected) {
    dot.className = "dot on";
    text.textContent = "MCPサーバに接続中";
  } else {
    dot.className = "dot off";
    text.textContent = "未接続 (MCPサーバを起動してください)";
  }
}

(async () => {
  const v = await chrome.storage.local.get("safetyMode");
  if (v.safetyMode) safety.value = v.safetyMode;
  safety.addEventListener("change", async () => {
    await chrome.storage.local.set({ safetyMode: safety.value });
    await chrome.runtime.sendMessage({
      type: "rpc",
      id: "popup-" + Date.now(),
      method: "setSafetyMode",
      params: { mode: safety.value },
    });
  });
  reconnect.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "reconnect" });
    refresh();
  });
  refresh();
  setInterval(refresh, 1500);
})();
