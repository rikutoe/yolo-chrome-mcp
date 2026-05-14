# 17ツール全件を Claude Code 経由で E2E

## Goal
Rikuto の Claude Code から実際に MCP ツールを呼んで、`scripts/e2e.mjs` で未検証だった以下を本物のセッションで通す:
- `click` / `type` (a11y stableId 経由の操作)
- `navigate` + `waitForStable` の連鎖
- `getTabInfo` (CDP attach できるタブで)
- `getSourceAt` / `getNetworkRequest`
- safety overlay の発火 (危険ラベルのボタン)

## Approach
リリース後に `claude mcp add` で登録、Claude に「example.com を新タブで開いてフォームに入力してくれ」みたいな実タスクを投げて挙動を観察する。

## Steps
- [ ] release-v0.1.0 完了
- [ ] `claude mcp add yolo-chrome -- npx -y yolo-chrome-mcp@latest`
- [ ] テスト用ページを開く (httpbin.org/forms/post など)
- [ ] Claude に「listTabs → getInteractables → type → click submit」を依頼、overlay 発火を確認
- [ ] cross-origin navigate を依頼、overlay 発火を確認
- [ ] 取得できたバグ/改善点を docs/PROJECT.md の Decisions に追加 or 次タスク化

## Notes
- 失敗パターンが見つかったら e2e.mjs にもケースを追加して回帰検知できる状態にする。
