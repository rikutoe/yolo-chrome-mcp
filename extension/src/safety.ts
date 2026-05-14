import * as cdp from "./cdp.js";

export type SafetyDecision = "allowed" | "denied";

const DANGEROUS_LABEL_PATTERNS = [
  /送信|送る|決済|支払|購入|注文|削除|消去|退会|解約|サブミット/i,
  /\b(submit|delete|remove|confirm|pay|buy|purchase|charge|withdraw|transfer|send)\b/i,
  /[¥$€£]\s*\d/,
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
    // Cross-origin navigation: ask. Same-origin: silent.
    try {
      const t = await chrome.tabs.get(tabId);
      const cur = new URL(t.url ?? "");
      const next = new URL(details.url);
      return cur.origin !== next.origin;
    } catch {
      return true;
    }
  }
  if (action === "click") {
    // Look at the element's text + nearby form.
    const stableId: string = details.stableId;
    const backendNodeId = Number(stableId.slice(1));
    if (!Number.isFinite(backendNodeId)) return false;
    try {
      const desc: any = await cdp.send(tabId, "DOM.describeNode", { backendNodeId, depth: 0 });
      const node = desc.node;
      const text = (node.nodeValue ?? "").toString();
      const attrs = node.attributes ?? [];
      const attrMap: Record<string, string> = {};
      for (let i = 0; i < attrs.length; i += 2) attrMap[attrs[i]] = attrs[i + 1];
      const corpus = [
        text,
        attrMap["value"] ?? "",
        attrMap["aria-label"] ?? "",
        attrMap["title"] ?? "",
        attrMap["name"] ?? "",
      ].join(" ");
      if (attrMap["type"] === "submit") return true;
      if (DANGEROUS_LABEL_PATTERNS.some((re) => re.test(corpus))) return true;
    } catch {
      // If we can't inspect, default to safe (cheaper than annoying prompts).
      return false;
    }
    return false;
  }
  if (action === "type") {
    // Typing is usually safe; only flag credit-card-shaped input.
    if (/\b\d{13,19}\b/.test(String(details.sample ?? ""))) return true;
    return false;
  }
  return false;
}
