// Injects overlay.js into the target tab and round-trips a yes/no prompt.

export async function promptInTab(
  tabId: number,
  action: string,
  details: any
): Promise<boolean> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["overlay.js"],
  });
  const reply = await chrome.tabs.sendMessage(tabId, {
    type: "yolo-confirm",
    action,
    details,
  });
  return !!reply?.allowed;
}
