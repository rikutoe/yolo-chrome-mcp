import * as cdp from "./cdp.js";

export type SafetyDecision = "allowed" | "denied";

// Truly sensitive: money movement, account-destructive, credential-sending.
// Generic "submit/send/confirm" は外す（普通のフォーム送信で毎回確認が出てしまうため）。
const MONEY_LABEL_PATTERNS = [
  /決済|支払|購入|注文|入金|出金|送金|振込|チャージ|引き落とし/i,
  /\b(pay|buy|purchase|checkout|charge|withdraw|transfer|deposit|wire)\b/i,
  /[¥$€£]\s*\d/,
];

const DESTRUCTIVE_LABEL_PATTERNS = [
  /アカウント削除|退会|解約|永久削除|完全削除/i,
  /\b(delete account|close account|deactivate|terminate account|permanently delete)\b/i,
];

// Returns true if the action looks risky.
export async function classifyAction(
  tabId: number,
  action: string,
  details: any
): Promise<boolean> {
  if (action === "evalJs") {
    const expr = String(details.expression ?? "");
    if (/document\.cookie\s*=/.test(expr)) return true;
    if (/fetch\(|XMLHttpRequest/.test(expr)) return true;
    if (/localStorage\.(setItem|clear)/.test(expr)) return true;
    return false;
  }
  if (action === "navigate") {
    // ナビゲーションは可逆で副作用が小さいので、原則プロンプトなし。
    return false;
  }
  if (action === "click") {
    const stableId: string = details.stableId;
    const backendNodeId = Number(stableId.slice(1));
    if (!Number.isFinite(backendNodeId)) return false;
    // Fast path: the cached AX label from getInteractables already covers most pages.
    // Only fall through to DOM.describeNode if the cached label looks suspicious — saves
    // one round-trip per click on the overwhelmingly common "safe button" case.
    const cachedLabel: string = details.cachedLabel ?? "";
    const cachedRole: string = details.cachedRole ?? "";
    const cachedLooksRisky =
      MONEY_LABEL_PATTERNS.some((re) => re.test(cachedLabel)) ||
      DESTRUCTIVE_LABEL_PATTERNS.some((re) => re.test(cachedLabel));
    if (cachedLooksRisky) return true;
    // For non-button roles (link, tab, option, checkbox, etc.) the cached AX label is
    // authoritative — those don't sit in password forms, so we can short-circuit here.
    const needsDomCheck = cachedRole === "button" || cachedRole === "" || !cachedRole;
    if (!needsDomCheck) return false;
    try {
      const desc: any = await cdp.send(tabId, "DOM.describeNode", { backendNodeId, depth: 0 });
      const node = desc.node;
      const text = (node.nodeValue ?? "").toString();
      const attrs = node.attributes ?? [];
      const attrMap: Record<string, string> = {};
      for (let i = 0; i < attrs.length; i += 2) attrMap[attrs[i]] = attrs[i + 1];
      const corpus = [
        text,
        cachedLabel,
        attrMap["value"] ?? "",
        attrMap["aria-label"] ?? "",
        attrMap["title"] ?? "",
        attrMap["name"] ?? "",
      ].join(" ");
      if (MONEY_LABEL_PATTERNS.some((re) => re.test(corpus))) return true;
      if (DESTRUCTIVE_LABEL_PATTERNS.some((re) => re.test(corpus))) return true;
      // submit ボタンでも、パスワード入力を含むフォーム内なら確認する。
      if (attrMap["type"] === "submit" || node.nodeName === "BUTTON") {
        if (await isInsidePasswordForm(tabId, backendNodeId)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }
  if (action === "type") {
    // クレジットカード番号らしい値、またはパスワード input への入力は確認。
    if (/\b\d{13,19}\b/.test(String(details.sample ?? details.text ?? ""))) return true;
    const stableId: string | undefined = details.stableId;
    // Most inputs come back as `textbox` from the AX tree — only password fields show up
    // as something else worth investigating. We still need DOM.describeNode to read the
    // `type=password` / `autocomplete=cc-*` attributes, but only when the role suggests it
    // could be sensitive.
    if (stableId) {
      const backendNodeId = Number(stableId.slice(1));
      if (Number.isFinite(backendNodeId)) {
        try {
          const desc: any = await cdp.send(tabId, "DOM.describeNode", { backendNodeId, depth: 0 });
          const attrs = desc.node.attributes ?? [];
          const attrMap: Record<string, string> = {};
          for (let i = 0; i < attrs.length; i += 2) attrMap[attrs[i]] = attrs[i + 1];
          if (attrMap["type"] === "password") return true;
          if (attrMap["autocomplete"]?.includes("cc-")) return true;
        } catch {
          // fall through
        }
      }
    }
    return false;
  }
  return false;
}

// 指定ノードの祖先 form に type="password" の input があるか調べる。
async function isInsidePasswordForm(tabId: number, backendNodeId: number): Promise<boolean> {
  try {
    const resolved: any = await cdp.send(tabId, "DOM.resolveNode", { backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) return false;
    const result: any = await cdp.send(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(){
        const f = this.closest && this.closest('form');
        if (!f) return false;
        return !!f.querySelector('input[type="password"]');
      }`,
      returnByValue: true,
    });
    return result.result?.value === true;
  } catch {
    return false;
  }
}
