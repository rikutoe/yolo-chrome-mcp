# yolo-chrome-mcp

## Overview

### Purpose
AI が「いま自分が開いている Chrome のどのタブでも」見て・触って・デバッグできる MCP サーバを提供する。Playwright/Puppeteer 系のように別 Chrome を立ち上げるのではなく、**ログイン済みの本物のセッションのまま** AI に渡すのが核。

### Background
既存 Chrome MCP は「読みだけ強い / ログイン状態が引き継げない / Console や Network が断片的」など用途ごとに穴がある。普段の作業で「このタブ Claude に見せて触らせたい」が成立しない。

### Goal
- 17 ツールが Claude Code から実 Chrome タブで動作する ✅
- 危険操作は in-tab 確認オーバーレイで止まる ✅
- 配布3経路 (npm/npx・MCPB・GitHub Release zip) が稼働 ✅
- v0.1.0 が npm に publish され、他人が `claude mcp add yolo-chrome -- npx -y yolo-chrome-mcp@latest` で使える

### Out of Scope
- 複数 Chrome プロファイル / 別ユーザーセッション切り替え
- ヘッドレス Chrome の起動 (本 MCP は "ユーザーが今使っている Chrome" 専用)
- Chrome Web Store 公開 (当面は GitHub Release zip + unpacked load)

## Current Phase
- Phase 1: 実装 (拡張 + MCP + safety overlay) ✅
- Phase 2: 配布パイプライン構築 (npm + MCPB + Actions) ✅
- **Phase 3: 初回公開リリース** ← current
- Phase 4: 採用と改善 (追加ツール、Web Store 公開、ドキュメント整備)

## Next
- [ ] `NPM_TOKEN` を repo Settings → Secrets に追加
- [ ] `git tag v0.1.0 && git push origin v0.1.0` で Actions を走らせ npm publish + GitHub Release を完走させる
- [ ] Rikuto の Claude Code 経由で 17 ツール全件 E2E (click/type/navigate含む) を実行し、動作証跡を残す

## Architecture

```
Claude ⇄ stdio ⇄ MCP server (Node)  ⇄ ws://127.0.0.1:8765 ⇄ Chrome extension (MV3)
                                                              └── chrome.debugger (CDP) → tab
```

### ディレクトリ

```
server/                Node + TypeScript MCP サーバ
  src/index.ts         エントリ + CLI サブコマンド (install/--version/--help)
  src/bridge.ts        ext との WS hub (1接続)
  src/tools.ts         17 ツール定義 (zod スキーマ)
  src/install.ts       `npx yolo-chrome-mcp install` ヘルパー
  src/zodToJsonSchema.ts  軽量変換器 (依存ゼロ)
  prepack.mjs          publish 前に ../extension/dist を ./extension にコピー

extension/             MV3 Chrome 拡張
  manifest.json        permissions: tabs/debugger/storage/scripting/cookies/alarms
  src/background.ts    WS クライアント + ハンドラルーティング + alarms キープアライブ
  src/cdp.ts           chrome.debugger 薄ラッパ
  src/session.ts       per-tab CDP attach + console/network リングバッファ
  src/handlers.ts      17 ツールのハンドラ実装
  src/safety.ts        危険操作判定 (label / submit / cross-origin / etc.)
  src/overlay.ts       in-tab 確認オーバーレイ (Shadow DOM)
  src/overlayBridge.ts overlay を inject → メッセージ送受信
  src/popup.ts         拡張ポップアップ (接続状態 + safety mode)
  build.mjs            esbuild バンドル

shared/                ワイヤプロトコル型 (現状未使用; server/extension 内に inline 複製)

mcpb/manifest.json     Claude Desktop MCPB バンドル用 manifest
scripts/build-mcpb.mjs  build/yolo-chrome-mcp-*.mcpb を生成
scripts/e2e.mjs        stdio 経由でツールを叩く E2E ドライバ
.github/workflows/release.yml  タグ push で npm publish + GitHub Release
```

### 重要なデータ構造
- **stableId**: `getInteractables` が返す要素 ID。`n{backendNodeId}` の形式。`click`/`type` の引数として使う。AI に座標を意識させない。
- **リングバッファ**: console/network 各 500 件。CDP イベントが発火する度に push、上限超過で先頭から捨てる。
- **safety mode**: `always` / `dangerous-only` (default) / `off`。chrome.storage.local に永続化。

## Decisions

- **D1: 拡張へのタブ opt-in トグルを作らない** — Rikuto の方針は「AIに丸ごと渡して AI に考えさせる」。代わりに危険操作だけ overlay で確認。(2026-05-14)
- **D2: ツールは粒度を分けて段階制 (Stage 1–5)** — 一発スナップショット系はコンテクストを浪費する。MCP の `instructions` で標準フロー (listTabs → 視認系1つ → 構造/深掘り) を提示する。(2026-05-14)
- **D3: DOM は accessibility tree から interactables だけ抽出** — 生 DOM ダンプは渡さない。role/label/stableId/座標で十分。(2026-05-14)
- **D4: WS は単一クライアント (last writer wins)** — 拡張 ↔ MCP は 1:1 接続。同時複数 Claude セッションは想定しない (将来必要なら sub-channel)。(2026-05-14)
- **D5: shared/ ワークスペースは作ったが現状未使用** — TypeScript の rootDir/paths が monorepo で噛み合わず、サーバと拡張で型を inline 複製した。後で本格的に共有が必要になったら整理する。(2026-05-14)
- **D6: MV3 SW のキープアライブは `chrome.alarms` 15秒間隔** — Offscreen Document は今回避けた (拡張権限が増える)。alarm 発火時に socket 切れていたら reconnect。(2026-05-14)
- **D7: 配布は3経路** — npm/npx (Claude Code 想定)、MCPB (Claude Desktop)、GitHub Release zip (拡張のみ手動)。Chrome Web Store は公開審査を待たない。(2026-05-14)
- **D8: ルート package 名は `yolo-chrome-mcp-monorepo`** — npm publish 対象の `server/` パッケージ名 `yolo-chrome-mcp` と衝突して `npm run -w` がおかしくなったため。(2026-05-14)
