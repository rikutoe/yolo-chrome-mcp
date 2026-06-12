import { getLang, resolveLang, t, type Lang } from "./i18n.js";

const dot = document.getElementById("dot")!;
const text = document.getElementById("text")!;
const sub = document.getElementById("sub")!;
const reconnect = document.getElementById("reconnect")!;
const reconnectLabel = document.getElementById("reconnectLabel")!;
const pin = document.getElementById("pin")! as HTMLButtonElement;
const pinHint = document.getElementById("pinHint")! as HTMLDivElement;
const pinDefaultHint = document.getElementById("pinDefaultHint")! as HTMLDivElement;
const accountEmail = document.getElementById("accountEmail")!;
const claimHint = document.getElementById("claimHint")! as HTMLDivElement;
const modeHint = document.getElementById("modeHint")!;
const versionEl = document.getElementById("version")!;
const setupCard = document.getElementById("setupCard")! as HTMLDivElement;
const cmdBlock = document.getElementById("cmdBlock")! as HTMLPreElement;
const copyCmd = document.getElementById("copyCmd")!;
const copyLabel = document.getElementById("copyLabel")!;
const langSelect = document.getElementById("lang")! as HTMLSelectElement;

const safetyInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="safety"]')
);

const SAFETY_HINT_KEY: Record<string, string> = {
  always: "safety_hint_always",
  "dangerous-only": "safety_hint_dangerous",
  off: "safety_hint_off",
};

let lang: Lang = "en";
let isPinned = false;
let safetyMode = "dangerous-only";

type ConnState = "on" | "off" | "idle";
let connState: ConnState = "off";

/** Re-render every string that depends on the active language. */
function applyLanguage() {
  // Static elements tagged with data-i18n.
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    if (key) el.textContent = t(lang, key);
  }
  // Dynamic strings.
  setHint(safetyMode);
  setPinUi(isPinned);
  renderState();
}

function renderState() {
  dot.className =
    connState === "on" ? "dot on" : connState === "idle" ? "dot idle" : "dot";
  text.textContent =
    connState === "on"
      ? t(lang, "status_connected")
      : connState === "idle"
        ? t(lang, "status_other")
        : t(lang, "status_disconnected");
  if (connState === "on") {
    sub.textContent = isPinned ? t(lang, "sub_pinned") : "";
  } else if (connState === "idle") {
    sub.textContent = "";
  } else {
    sub.textContent = t(lang, "sub_setup");
  }
  setupCard.hidden = connState !== "off";
  claimHint.hidden = connState !== "idle";
  // The default-behavior hint only matters while normally connected + unpinned.
  pinDefaultHint.hidden = !(connState === "on" && !isPinned);
  // The claim button is always available; just relabel it by state.
  reconnectLabel.textContent =
    connState === "on" ? t(lang, "btn_reconnect") : t(lang, "btn_connect_here");
}

function setState(state: ConnState) {
  connState = state;
  renderState();
}

function setPinUi(pinnedNow: boolean) {
  isPinned = pinnedNow;
  pin.classList.toggle("pinned", pinnedNow);
  pin.title = pinnedNow ? t(lang, "pin_title_unpin") : t(lang, "pin_title_pin");
  pinHint.hidden = !pinnedNow;
}

async function refresh() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "status" });
    accountEmail.textContent = r?.email || t(lang, "account_none");
    setPinUi(!!r?.pinned);
    if (r?.connected) setState("on");
    else if (r?.suppressed) setState("idle");
    else setState("off");
  } catch {
    accountEmail.textContent = t(lang, "account_none");
    setState("off");
    sub.textContent = t(lang, "sub_reload");
  }
}

function setHint(mode: string) {
  modeHint.textContent = t(lang, SAFETY_HINT_KEY[mode] ?? "safety_hint_dangerous");
}

(async () => {
  try {
    const manifest = chrome.runtime.getManifest();
    versionEl.textContent = `v${manifest.version}`;
  } catch {
    /* noop */
  }

  const stored = await chrome.storage.local.get(["safetyMode", "lang"]);
  safetyMode = (stored.safetyMode as string) ?? "dangerous-only";
  for (const input of safetyInputs) input.checked = input.value === safetyMode;

  langSelect.value = (stored.lang as string) ?? "auto";
  lang = await getLang();
  applyLanguage();

  langSelect.addEventListener("change", async () => {
    const choice = langSelect.value; // "auto" | "en" | "ja" | "zh"
    await chrome.storage.local.set({ lang: choice });
    lang = resolveLang(choice === "auto" ? undefined : choice);
    applyLanguage();
  });

  for (const input of safetyInputs) {
    input.addEventListener("change", async () => {
      if (!input.checked) return;
      safetyMode = input.value;
      setHint(safetyMode);
      await chrome.storage.local.set({ safetyMode });
      await chrome.runtime.sendMessage({
        type: "rpc",
        id: "popup-" + Date.now(),
        method: "setSafetyMode",
        params: { mode: safetyMode },
      });
    });
  }

  reconnect.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "reconnect" });
    refresh();
  });

  pin.addEventListener("click", async () => {
    const next = !isPinned;
    setPinUi(next); // optimistic
    renderState();
    await chrome.runtime.sendMessage({ type: "setPin", pinned: next });
    refresh();
  });

  copyCmd.addEventListener("click", async () => {
    const cmd = cmdBlock.textContent ?? "";
    try {
      await navigator.clipboard.writeText(cmd);
      copyLabel.textContent = t(lang, "copy_done");
    } catch {
      copyLabel.textContent = t(lang, "copy_fail");
    }
    setTimeout(() => {
      copyLabel.textContent = t(lang, "btn_copy");
    }, 1500);
  });

  refresh();
  setInterval(refresh, 1500);
})();
