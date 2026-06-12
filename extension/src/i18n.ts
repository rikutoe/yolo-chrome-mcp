// Tiny runtime i18n for the popup + overlay. Chrome's native chrome.i18n is
// locked to the browser UI language and can't be overridden at runtime, so we
// keep our own dictionaries: auto-detect from the UI language by default, but
// allow a user override stored in chrome.storage.local under "lang".

declare const chrome: any;

export type Lang = "en" | "ja" | "zh";
export const LANGS: Lang[] = ["en", "ja", "zh"];

type Dict = Record<string, string>;

const en: Dict = {
  status_checking: "Checking…",
  status_connected: "Connected",
  status_other: "Another profile in use",
  status_disconnected: "Not connected",
  sub_searching: "Looking for the MCP server",
  sub_pinned: "Pinned to this browser",
  sub_setup: "Set up using the command below",
  sub_reload: "Please reload the extension",
  account_none: "(not signed in to Chrome)",
  pin_default_hint:
    "By default it auto-connects to the focused window. Click 📌 to pin the target.",
  pin_hint:
    "Connection pinned. Even if you use another Chrome profile, the AI keeps operating this one. By default it auto-connects to the focused window.",
  claim_hint:
    "Another profile is connected. Click 📌 above to switch here and pin it.",
  pin_title_pin: "Pin connection",
  pin_title_unpin: "Unpin connection",
  btn_reconnect: "Reconnect",
  btn_connect_here: "Connect with this profile",
  label_setup: "Setup",
  setup_desc:
    "This extension alone won't work. Run the command below once in a terminal to connect the local MCP server with Claude.",
  setup_hint:
    "After running it, restart Claude Code / Claude Desktop and this turns green. Requires Node.js and Claude Code (or Claude Desktop).",
  btn_copy: "Copy command",
  copy_done: "Copied",
  copy_fail: "Copy failed",
  label_safety: "Safety",
  safety_all: "All",
  safety_recommended: "Recommended",
  safety_off: "Off",
  safety_hint_always: "Shows a confirmation dialog for every action.",
  safety_hint_dangerous:
    "Confirms only risky actions: payments, account deletion, password submission, etc.",
  safety_hint_off:
    "Runs everything automatically with no confirmation. Use with care.",
  label_language: "Language",
  lang_auto: "🌐 Auto",
  overlay_title: "The AI wants to perform: {action}",
  overlay_deny: "Deny",
  overlay_allow: "Allow",
};

const ja: Dict = {
  status_checking: "確認中…",
  status_connected: "接続中",
  status_other: "別のプロファイルが使用中",
  status_disconnected: "未接続",
  sub_searching: "MCP サーバを探しています",
  sub_pinned: "このブラウザに固定中",
  sub_setup: "下のコマンドでセットアップしてください",
  sub_reload: "拡張機能をリロードしてください",
  account_none: "（Chrome にサインインなし）",
  pin_default_hint:
    "通常はフォーカスされているウィンドウに自動接続します。📌 で接続先を固定できます。",
  pin_hint:
    "接続先を固定中。他の Chrome プロフィールを操作しても、AI はこのプロフィールを操作し続けます。通常はフォーカスされているウィンドウに自動接続します。",
  claim_hint:
    "いま別のプロファイルが接続中です。上の 📌 をクリックすれば、こちらに切り替えて固定できます。",
  pin_title_pin: "接続先を固定",
  pin_title_unpin: "接続先の固定を解除",
  btn_reconnect: "再接続",
  btn_connect_here: "このプロファイルで接続",
  label_setup: "セットアップ",
  setup_desc:
    "この拡張だけでは動きません。ターミナルで下のコマンドを一度実行して、ローカルの MCP サーバと Claude を接続してください。",
  setup_hint:
    "実行後、Claude Code / Claude Desktop を再起動するとここが緑になります。Node.js と Claude Code（または Claude Desktop）が必要です。",
  btn_copy: "コマンドをコピー",
  copy_done: "コピーしました",
  copy_fail: "コピー失敗",
  label_safety: "セーフティ",
  safety_all: "全確認",
  safety_recommended: "推奨",
  safety_off: "オフ",
  safety_hint_always: "すべての操作で確認ダイアログを出します。",
  safety_hint_dangerous: "決済・退会・パスワード送信・危険な操作のみ確認します。",
  safety_hint_off: "確認なしですべて自動実行します。注意して使ってください。",
  label_language: "言語",
  lang_auto: "🌐 自動",
  overlay_title: "AIが操作しようとしています: {action}",
  overlay_deny: "拒否",
  overlay_allow: "許可",
};

const zh: Dict = {
  status_checking: "检查中…",
  status_connected: "已连接",
  status_other: "其他配置文件正在使用",
  status_disconnected: "未连接",
  sub_searching: "正在查找 MCP 服务器",
  sub_pinned: "已固定到此浏览器",
  sub_setup: "请使用下方命令进行设置",
  sub_reload: "请重新加载扩展程序",
  account_none: "（未登录 Chrome）",
  pin_default_hint: "默认会自动连接到当前聚焦的窗口。点击 📌 可固定连接目标。",
  pin_hint:
    "连接已固定。即使你操作其他 Chrome 配置文件，AI 仍会继续操作此配置文件。默认会自动连接到当前聚焦的窗口。",
  claim_hint: "当前是其他配置文件在连接。点击上方的 📌 即可切换到此处并固定。",
  pin_title_pin: "固定连接",
  pin_title_unpin: "取消固定连接",
  btn_reconnect: "重新连接",
  btn_connect_here: "使用此配置文件连接",
  label_setup: "设置",
  setup_desc:
    "仅靠此扩展无法工作。请在终端中运行下方命令一次，将本地 MCP 服务器与 Claude 连接。",
  setup_hint:
    "运行后，重启 Claude Code / Claude Desktop，此处会变为绿色。需要 Node.js 和 Claude Code（或 Claude Desktop）。",
  btn_copy: "复制命令",
  copy_done: "已复制",
  copy_fail: "复制失败",
  label_safety: "安全",
  safety_all: "全部",
  safety_recommended: "推荐",
  safety_off: "关闭",
  safety_hint_always: "对所有操作都弹出确认对话框。",
  safety_hint_dangerous: "仅对付款、注销账户、提交密码等危险操作进行确认。",
  safety_hint_off: "不经确认自动执行所有操作。请谨慎使用。",
  label_language: "语言",
  lang_auto: "🌐 自动",
  overlay_title: "AI 想要执行操作：{action}",
  overlay_deny: "拒绝",
  overlay_allow: "允许",
};

const MESSAGES: Record<Lang, Dict> = { en, ja, zh };

/** Best-effort language from the browser UI language. */
export function detectLang(): Lang {
  let ui = "en";
  try {
    ui = (chrome.i18n.getUILanguage() || "en").toLowerCase();
  } catch {}
  if (ui.startsWith("ja")) return "ja";
  if (ui.startsWith("zh")) return "zh";
  return "en";
}

/** Resolve a stored override ("auto"/"en"/"ja"/"zh") to a concrete language. */
export function resolveLang(override?: string): Lang {
  if (override === "en" || override === "ja" || override === "zh") return override;
  return detectLang();
}

/** Read the effective language, honoring the stored override. */
export async function getLang(): Promise<Lang> {
  try {
    const { lang } = await chrome.storage.local.get("lang");
    return resolveLang(lang);
  } catch {
    return detectLang();
  }
}

export function t(lang: Lang, key: string, vars?: Record<string, string>): string {
  let s = MESSAGES[lang]?.[key] ?? en[key] ?? key;
  if (vars) for (const k in vars) s = s.split(`{${k}}`).join(vars[k]);
  return s;
}
