# yolo-chrome-mcp 実装計画 ── 自分のChromeを丸ごとAIに渡して、見せて・触らせて・直させる

**作成日:** 2026-05-14
**ステータス:** 下書き
**関連:** (なし。新規プロジェクト)

---

## 1. 背景

既存の Chrome 操作系 MCP(Claude in Chrome、Control Chrome、Preview など)は、それぞれ「読みは強いが書きは弱い」「新しいタブを立ち上げる前提でログイン状態を引き継げない」「Console や Network が断片的にしか取れない」など、用途ごとに穴がある。自分が普段使っている Chrome そのもの ── 既にログイン済みのタブ群、拡張機能、開きっぱなしの作業状態 ── にAIが入ってきて、見て・触って・デバッグして、必要なら直すところまでやってほしい、というのが本体の欲求。

本イテレーションが狙うもの: **"今開いている自分の Chrome のどのタブでも、AIにそのまま渡せる" 状態を作ること。** タブを指定すれば、AIは画面・DOM・Console・Network・Storage を全部見られて、操作もできて、必要ならコードを書き換えるところまで一連で回せる。

---

## 2. 目指す体験

### 体験1 ── AIが自分でタブを探して特定できる

**ユーザーが見るもの:**
ユーザーは「GitHubのPR画面でなんか出てる」みたいに**曖昧な指示**を出すだけ。AIが裏で `listTabs` を叩いてタイトルとURLの一覧を取り、対象タブを自分で特定する。opt-inやトグルのような事前準備はなく、Chromeで開いているものは全部AIから見える前提。タブ特定後、必要なら `getTabInfo(tabId)` でそのタブだけ詳細情報を追加取得する。

**コンテクスト:**
"渡すタブを選ばせる" UIは結局ユーザーに手間を寄せる。Rikuto の方針は **AIに丸ごと渡してAIに考えさせる** 側。代わりに、危険操作はあとの体験5で個別に確認させる。

**実装方向の案:**
Chrome拡張(MV3)を `chrome.tabs` 権限で作り、MCPツール `listTabs()`(全タブのid/title/url/active状態)と `getTabInfo(tabId)`(そのタブの基本メタ: faviconURL、開かれた時刻、フレーム構成 など軽量情報のみ)を提供する。重い情報は体験2の専用ツールに分離。

---

### 体験2 ── 必要な粒度だけ取れる、分かれたデバッグツール群

**ユーザーが見るもの:**
AIは状況に応じて必要な情報だけを取りに行ける。「画面だけ見たい」なら `screenshot` 、「コンソールエラーだけ知りたい」なら `getConsoleLogs` 、「最近のNetworkだけ」なら `getNetworkActivity` 、「ナビゲートしたい」なら `getInteractables` でクリック可能要素・入力欄・リンクだけが意味付き(role/label/visibleText/座標)で返ってくる。**いきなり巨大なDOMダンプを返すツールは存在しない。**

**コンテクスト:**
"スナップショット一発" は便利に見えて、毎回大量のトークンを食う。実際のデバッグや操作は **欲しい情報がその時々で違う**ので、ツールを細かく分けてAIに選ばせるほうがコンテクスト効率も精度も上がる。特にDOMは生のツリーを渡すと無駄が大きいので、操作に必要な要素だけ抽出する形に最初から寄せる。

**実装方向の案:**
CDP (`chrome.debugger`) を対象タブにアタッチし、ドメイン別に独立したMCPツールを生やす。
- `screenshot(tabId, {fullPage?})` ── 画像のみ
- `getConsoleLogs(tabId, {since?, level?})` ── ログのみ、フィルタ可
- `getNetworkActivity(tabId, {since?, failedOnly?})` ── リクエスト要約
- `getInteractables(tabId, {viewport?})` ── クリック可能 / 入力可能 / リンク要素を、ARIA role + 表示テキスト + 安定ID + 座標で返す。生のHTMLは返さない。
- `getPageText(tabId)` ── 可視テキストのみ(本文読み取り用)
- `getStorage(tabId, {types})` ── cookie / localStorage / sessionStorage を必要分だけ

`getInteractables` の抽出は accessibility tree (`Accessibility.getFullAXTree`) ベースにすると、role/label が最初から付いていてLLMに渡しやすい。

---

### 体験3 ── タブを操作できる(クリック、入力、スクロール、JS実行)

**ユーザーが見るもの:**
AIに「このフォーム埋めて送信して」と頼むと、実際に自分の画面上でカーソルが動いてフォームが埋まり、送信ボタンが押される。ログイン済みのセッションのまま、手で操作するのと同じ結果が出る。AIがJSを実行したい場合は、対象タブのコンソールで `eval` が走ったように見える。

**コンテクスト:**
新規Chromeを立ち上げる系のMCP(Playwright/Puppeteer ベース)はログインからやり直しになる。普段のセッションに乗ったまま操作できることが、SaaS管理画面や社内ツールでのデバッグでは決定的に違う。

**実装方向の案:**
操作は CDP の `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Runtime.evaluate` で実装。クリック対象は体験2の `getInteractables` が返した安定ID(AXNodeId or backendNodeId)で指定する。AIは座標を意識しない。

---

### 体験4 ── ページのエラーや遅さを、AIが原因まで掘れる

**ユーザーが見るもの:**
「このページなぜか重い」「コンソールに赤いの出てる」とAIに振ると、Networkのウォーターフォール要約(どのリクエストが何msかかったか、失敗したか)と、Consoleのエラースタックトレース、関連するJSソースの該当行までが返ってくる。AIは「この XHR が5秒かかってる、レスポンスは500、サーバ側のエラーっぽい」のような結論まで出す。

**コンテクスト:**
デバッグ用途を本気でやろうとすると、Network/Console/Source が紐付いた状態でAIに見せられるかが要。"スクショ撮ってAIに渡す" だけだと根本原因にたどり着けない。

**実装方向の案:**
CDPの `Network.*` / `Console.*` / `Debugger.*` ドメインを購読しっぱなしにしておき、MCPツールとして `getNetworkActivity` / `getConsoleErrors` / `getSourceAt(url, line)` を提供。スタックトレースが出たら sourcemap 解決まで拡張側でやる。

---

### 体験5 ── 危険な操作はワンクッション置かれる

**ユーザーが見るもの:**
AIが「お金が動く」「データを消す」「外部に送信する」っぽい操作(送金ボタン、削除ボタン、SubmitでPOSTが飛ぶフォームなど)をしようとした瞬間、画面上に「AIが ○○ を実行しようとしています。許可しますか?」というオーバーレイが出る。ユーザーがOKを押さない限り操作は止まる。読み取り系・無害なナビゲーションはノンストップ。

**コンテクスト:**
"自分の Chrome をそのまま渡す" モデルは強力だが、AIの誤操作コストも大きい。**渡したタブの中で何でもできる** ことを許容する代わりに、**不可逆操作だけはユーザー確認** が要る。

**実装方向の案:**
拡張のSW側で、AIから来た操作リクエストを「対象要素のテキスト / type=submit / 金額っぽい文字列 / 確認ダイアログを伴うクラス名」などのヒューリスティクスで分類し、危険判定なら content script 経由でフルスクリーンの確認オーバーレイを出す。確認モード(常に確認 / 危険時のみ / 確認なし)はポップアップで切り替え可能。

---

### 体験6 ── AIが書いたコード修正を、その場のページに当てて即確認できる

**ユーザーが見るもの:**
ローカルで開発しているWebアプリを Chrome で開いている時、AIに「このボタンの位置ずれてる、直して」と頼むと、AIがソース修正(ファイル編集)→ ブラウザが自動リロード → 直ったか自分でスクリーンショットで確認、までを1ループで回す。ユーザーは結果だけ見れば良い。

**コンテクスト:**
"ブラウザで動作確認できるAI" の真価は、コード修正と確認のループが閉じることにある。MCP単体だと "ブラウザを見るだけ" になりがちなので、開発中ローカルサーバの自動リロードと組み合わせる動線を最初から想定する。

**実装方向の案:**
これはMCPの直接の責務ではなく、AI(Claude Code等)がファイル編集ツールと本MCPのスナップショット取得を交互に呼ぶことで実現する。MCP側で必要なのは "リロード後の安定状態を待ってからスナップショットを返す" 振る舞い(`networkidle` 相当の待ち)。

---

## 3. ツール一覧

| ツール | 何をするか | デフォルト挙動 |
|---|---|---|
| `listTabs` | 全タブの id / title / url / active | - |
| `getTabInfo(tabId)` | 軽量メタ(favicon, 開いた時刻, frame構成) | - |
| `screenshot(tabId, {fullPage?})` | 画面キャプチャ | viewport のみ |
| `getPageText(tabId, {offset?})` | 可視テキスト | 冒頭2000字 + truncated フラグ |
| `getInteractables(tabId, {viewport?})` | クリック可/入力可要素を role+label+安定ID+座標で | viewport 内のみ |
| `getConsoleLogs(tabId, {since?, level?})` | Consoleログ | level:error / 直近20件 |
| `getNetworkActivity(tabId, {since?, failedOnly?})` | リクエスト要約 | failedOnly:true / 直近20件 |
| `getNetworkRequest(tabId, requestId)` | 個別リクエストの詳細(headers/body) | - |
| `getStorage(tabId, {types})` | cookie/localStorage/sessionStorage を指定種別だけ | - |
| `getSourceAt(tabId, url, line, {range?})` | JSソース該当行(sourcemap解決) | ±10行 |
| `click(tabId, nodeId)` | 安定IDで要素クリック。危険判定なら確認 | - |
| `type(tabId, nodeId, text)` | 入力欄にテキスト | - |
| `scroll(tabId, {to or by})` | スクロール | - |
| `navigate(tabId, url)` | 同タブ内遷移 | - |
| `evalJs(tabId, expression)` | JS実行。破壊的判定の対象 | - |
| `waitForStable(tabId, {timeout?})` | networkidle相当まで待つ | timeout 5s |
| `setSafetyMode(mode)` | always / dangerous-only / off | - |

---

## 4. コンテクスト節約の設計

AIが「全DOMを一発で読む」みたいな手を選ばずに、自然に段階を踏む形にする。

**① ツールにStage番号を持たせ、descriptionで誘導する**
listTabs(Stage1) → screenshot/getPageText(Stage2) → getInteractables(Stage3) → getConsoleLogs/getNetworkActivity(Stage4) → getSourceAt(Stage5)。各ツールのdescriptionに「Stage X、上位Stageを先に通せ」と明記する。

**② デフォルトを狭く、広げるのは明示オプトイン**
screenshot は viewport のみ、Logs/Network は filter+件数制限つき、getPageText は先頭+truncated フラグ、getInteractables は viewport 内のみ。「全部欲しい」は引数で明示しないと取れない。

**③ サマリ+ハンドル方式で詳細を分離**
getNetworkActivity は `{total, failed, slow, items[上位]}` だけ返し、深掘りは `getNetworkRequest(requestId)` で個別取得。getInteractables も生HTMLは返さず安定IDだけ。AIは「サマリで当たりをつけて、必要な1件だけ詳細を取る」流れになる。

**④ MCPの `instructions` で標準フローを渡す**
サーバ起動時にクライアントへ「listTabs → 視認系1つ → 必要なら構造/深掘り、フィルタ必須、evalJs は最後」というレシピを送る。AI側はそれを読んで標準経路を取る。

---

## 5. スコープ外

### 確定的に保留
- 複数Chromeプロファイル / 別ユーザーセッションへの切り替え
- ヘッドレスChromeの起動(本MCPは "ユーザーが今使っているChrome" 専用)
- 拡張機能のChrome Web Store公開(当面は手動インストール=Developer Mode)

### 追加情報待ち
- 「危険操作」判定のチューニング基準。最初はヒューリスティクスだが、誤判定が多ければルール定義を外部化する。
- Network/Console のリングバッファ上限(メモリとAI往復コストのトレードオフ)。最初は固定値で進める。

### 暫定値で進める部分
- スクリーンショットの解像度 / 圧縮率は暫定 1.5x DPR / JPEG 80。AIが読みづらいフィードバックが出たら上げる。

---

## 6. 完了条件

- 6つの体験が、実在のWebサイト(例: GitHub、Gmail、ローカルdev server)で動作する
- 拡張がインストール状態で常駐していても、普段のブラウジングに体感の遅延が出ない
- MCPサーバが Claude Code / Claude Desktop の両方から接続できる
- 危険操作の確認オーバーレイが、最低限「フォーム submit」「金額を含むボタン」で発火する
- README に手動インストール手順と Claude 設定例が載っている

---

## 7. 関連ドキュメント

- (実装着手後) `docs/ARCHITECTURE.md` ── 拡張 ↔ MCPサーバ間のプロトコル
- (実装着手後) `README.md` ── インストール手順、Claude設定例
- `/Users/rikuto/.claude/CLAUDE.md` ── デプロイ前のローカル確認ルール
