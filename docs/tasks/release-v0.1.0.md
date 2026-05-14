# v0.1.0 を初回リリースする

## Goal
他人が以下のコマンドだけで使える状態を作る。

```
claude mcp add yolo-chrome -- npx -y yolo-chrome-mcp@latest
npx yolo-chrome-mcp install
```

加えて Claude Desktop 向けに `.mcpb` を GitHub Release から DL → ドラッグ&ドロップで入る状態。

## Approach
タグを切って `.github/workflows/release.yml` を発火させる。CI 内で:
1. ビルド (`npm run build:all`)
2. 拡張 zip パック
3. `npm publish --provenance` (要 `NPM_TOKEN`)
4. GitHub Release 作成 + `.mcpb` と extension zip を添付

## Steps
- [ ] npm にアカウント作成済か確認、`yolo-chrome-mcp` のパッケージ名が空いているか `npm view yolo-chrome-mcp` で確認
- [ ] `NPM_TOKEN` (Automation token) を npm で発行
- [ ] GitHub repo Settings → Secrets and variables → Actions に `NPM_TOKEN` 追加
- [ ] `git tag v0.1.0 && git push origin v0.1.0`
- [ ] Actions のログで publish 成功を確認
- [ ] `npx yolo-chrome-mcp@0.1.0 --version` がローカルから取れることを確認
- [ ] GitHub Release ページに `.mcpb` と extension zip が添付されているか確認

## Notes
- 名前が空いていない場合は `@rikutoe/yolo-chrome-mcp` の scoped 名に切り替え (README/install.ts の publish コマンド例も合わせて更新)。
- 初回 publish は `--access public` (scoped の場合) が必須。
