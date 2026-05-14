# CLAUDE.md

## ドキュメント駆動
- セッション開始時: `docs/PROJECT.md` を読み、現状と Current Phase を把握してから動く
- タスク完了時・構造変更時: `doc-driven` skill を呼んでドキュメントを同期する
- 技術判断をしたら `docs/PROJECT.md` の Decisions に1行追加する

## このプロジェクト固有
- 拡張↔サーバの WS プロトコルは `server/src/wire.ts` と `extension/src/wire.ts` に inline 複製している。片方変えたら両方変える。
- MV3 SW は `chrome.alarms` で 15秒間隔キープアライブ。reconnect ロジックは `extension/src/background.ts` 末尾。
- 拡張をリビルドした後は `chrome://extensions` でカードの ↻ リロードを押さないと反映されない。
- 新しいツールを追加する時の手順:
  1. `server/src/tools.ts` に zod スキーマ + description (Stage番号付き) を追加
  2. `extension/src/handlers.ts` にハンドラ実装
  3. `extension/src/background.ts` の `handlers` テーブルに登録
  4. `scripts/e2e.mjs` にテストケース追加
- 配布: タグ push (`v*`) で `.github/workflows/release.yml` が npm publish + GitHub Release を作る。`NPM_TOKEN` secret が必要。
