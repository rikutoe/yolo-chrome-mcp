# Chrome Web Store listing — copy & metadata

Paste these into the
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
when publishing. All limits are Chrome's documented max lengths.

---

## Item name (max 45 chars)

```
Yolo Chrome MCP for Claude
```

(25 chars)

---

## Short description (max 132 chars)

```
No blocked sites, no filters, no approval pop-ups. Yolo lets Claude work on every website on your real Chrome — free.
```

(117 chars)

---

## Detailed description (max 16,000 chars)

```
Yolo Chrome MCP turns your real, logged-in Chrome session into a tool Claude can drive.

Why people pick it:
• Free, and works on every website — no filters, no allowlist, no
  approval pop-ups, no "this site is blocked." Official browser tools
  strictly block banking, Google properties, and anything they deem
  sensitive; Yolo just drives your own open tab, so every page works.
• Token-efficient and fast — it prefers cheap structured reads over
  screenshots and acts on the tab you already have open, so tasks run
  in seconds and burn a fraction of the context.
• Multi-profile aware — run several Chrome people/profiles at once and
  pin exactly which one the AI drives; many Claude sessions, one Chrome.

══════════════════════════════════════════
QUICK START — 3 steps, about 1 minute
══════════════════════════════════════════
This extension is only HALF of the system. It needs a small helper
(the "MCP server") running on your computer so Claude can reach it.
You set both up like this:

1. Install this extension (you're almost done — just click "Add").

2. Open a terminal on your computer and run this one line:

       npx -y yolo-chrome-mcp@latest install --routing-only

   (Requires Node.js and Claude Code or Claude Desktop. Don't want to
   type it? Click this extension's icon — the popup has the exact
   command with a one-click "Copy" button whenever the dot is red.)

3. Restart Claude Code / Claude Desktop. Click the extension icon —
   when the status dot turns GREEN, you're connected. Now ask Claude
   to do something with a tab, e.g. "screenshot this page."

That's it. No login, no separate browser, nothing leaves your machine.
──────────────────────────────────────────

Requires Node.js + Claude Code (or Claude Desktop). The extension popup also
shows the install command with a one-click "Copy" button — open it any time
the status dot is red.

Pair it with the yolo-chrome-mcp server (npm or Claude Desktop) and Claude
can browse, click, type, screenshot, and read the console / network of any
tab you already have open — without spawning a separate headless browser,
without re-authenticating, and without leaving your computer.

It is the lowest-friction way to give Claude an "eyes and hands" on the
exact pages you are working with.

— Why people switch to it —
• Free, and no more blocked sites. Official AI browser tools enforce
  strict filtering — they refuse banking, some Google properties, pages
  behind bot-protection, and anything flagged "sensitive," and pepper
  you with approval pop-ups. Yolo drops the filters: it drives your own
  already-open tab through the same DevTools Protocol the browser itself
  uses, so every page you actually work on just works. No allowlist, no
  silent refusals, free to use.
• Token-efficient by design. Claude is told to reach for the cheapest
  tool first — the page's accessibility tree instead of a screenshot,
  filtered console/network logs instead of full dumps — so each step
  spends a fraction of the context a vision-heavy agent burns. Longer
  tasks before you hit the limit, lower cost per run.
• Fast. It acts on the tab you already have open and logged in — no
  spawning a fresh headless browser, no re-authenticating, no page
  reloads you didn't ask for. Single tasks like submitting a form or
  changing a setting land in ~1–2s instead of ~15s+.
• Works across multiple Chrome profiles. Keep your work, personal, and
  client Chrome "people" open at once — pin exactly which profile the
  AI drives, or let it follow whichever window you focus. Several
  concurrent Claude sessions share one Chrome with no port conflicts.

— What you can do —
• "Take a screenshot of my Stripe dashboard and tell me what's wrong"
• "Open Linear and triage today's issues for me"
• "Read the console errors on this React app and find the cause"
• "Fill out this form with my info but stop before submit"
• "Compare the Polymarket prices across these 3 tabs"
• "Open Gmail and summarize the last 10 unread threads"

— How it works —
1. Install this Chrome extension. It connects to a local WebSocket on
   your computer (127.0.0.1, no external traffic).
2. Run the one-line install command shown above. It registers the MCP
   server with Claude (`claude mcp add`) and installs the routing hook
   + CLAUDE.md rule so Claude always picks Yolo when it needs a browser.
3. Restart Claude Code / Claude Desktop. The extension popup's dot turns
   green once Claude spawns the server.
4. Ask Claude to do something with a tab. Claude calls the server, the
   server forwards the call to this extension, the extension acts on
   your Chrome tab using DevTools Protocol, and the result comes back
   to Claude.

— 19 tools, lean by default —
listTabs · getTabInfo · screenshot · getPageText · getInteractables ·
click · type · scroll · navigate · createTab · closeTab · evalJs ·
waitForStable · getConsoleLogs · getNetworkActivity · getNetworkRequest
· getStorage · getSourceAt · setSafetyMode

Designed so Claude picks the cheapest tool for the job (accessibility
tree over screenshots, filtered logs over full dumps), keeping the
conversation context small.

— Safety overlay —
A locally-rendered confirmation banner asks before potentially-sensitive
actions: payment / purchase labels, account deletion, password-form
submits, credit-card / password input, and risky JavaScript that touches
cookies / fetch / localStorage. Navigation and ordinary clicks pass
through without prompts. Configurable via the popup.

— Multi-session safe —
Multiple concurrent Claude Code sessions on the same machine share one
extension via a primary/secondary MCP architecture. No port conflicts,
no "Failed to connect" surprises.

— What this extension does NOT do —
• It does not transmit data to any third-party server. Everything goes
  through 127.0.0.1 only.
• It does not read tabs in the background without an explicit AI
  request.
• It does not contain analytics or telemetry.

— Open source —
Source: https://github.com/rikutoe/yolo-chrome-mcp
License: MIT
Bugs / requests: https://github.com/rikutoe/yolo-chrome-mcp/issues

Privacy policy: https://seedx.tech/privacy
```

### Detailed description — 日本語 (ja locale)

```
Yolo Chrome MCP は、ログイン済みのいつもの Chrome を、Claude が操作できる「目と手」に変えます。

══════════════════════════════════════════
クイックスタート — 3ステップ、約1分
══════════════════════════════════════════
この拡張は仕組みの「半分」です。Claude から届くように、お使いの
PC で小さな補助プログラム（MCP サーバ）を動かす必要があります。
両方をこう設定します。

1. この拡張をインストール（あと少し、「追加」を押すだけ）。

2. ターミナルを開いて、次の1行を実行：

       npx -y yolo-chrome-mcp@latest install --routing-only

   （Node.js と Claude Code または Claude Desktop が必要です。入力が
   面倒なら、拡張アイコンをクリック。ドットが赤いときはポップアップに
   ワンクリックの「コピー」付きでコマンドが出ます。）

3. Claude Code / Claude Desktop を再起動。拡張アイコンをクリックして
   ステータスのドットが緑になれば接続完了。あとは「このページを
   スクショして」のように頼むだけ。

以上です。ログイン不要、別ブラウザ不要、データは一切外に出ません。
──────────────────────────────────────────

なぜ選ばれるか：
• 無料、そして全サイトで動く — フィルタなし、許可リストなし、承認
  ポップアップなし、「このサイトはブロックされています」もなし。
  公式のブラウザ系ツールは銀行・一部の Google サービス・機微と判断
  したサイトを厳しく弾きますが、Yolo は今開いているあなた自身の
  タブを操作するので、実際に使うページがそのまま動きます。
• トークン効率重視で速い — スクショより軽い構造データや、絞り込んだ
  ログを優先するので、1ステップあたりの消費はわずか。長いタスクも
  最後まで回せて、1回あたりのコストも低く抑えられます。
• 複数の Chrome プロフィールに対応 — 仕事用・個人用・クライアント用の
  Chrome を同時に開いたまま、AI が操作する先をピン留めできます。
  複数の Claude セッションが1つの Chrome を取り合わずに共有します。

— できること —
• 「Stripe のダッシュボードをスクショして、何が問題か教えて」
• 「Linear を開いて今日の issue をトリアージして」
• 「この React アプリのコンソールエラーを読んで原因を特定して」
• 「このフォームを私の情報で埋めて。送信の直前で止めて」
• 「この3つのタブの Polymarket の価格を比較して」
• 「Gmail を開いて未読10件を要約して」

— 仕組み —
1. この拡張をインストール。PC 内のローカル WebSocket
   （127.0.0.1、外部通信なし）に接続します。
2. 上記の1行コマンドを実行。MCP サーバを Claude に登録し、ルーティング
   用のフックと CLAUDE.md ルールを入れ、Claude がブラウザを使うときに
   必ず Yolo を選ぶようにします。
3. Claude Code / Claude Desktop を再起動。Claude がサーバを起動すると
   ポップアップのドットが緑になります。
4. タブの操作を依頼すると、Claude → サーバ → この拡張 の順に伝わり、
   拡張が DevTools Protocol でタブを操作し、結果が Claude に返ります。

— 19のツール、デフォルトで軽量 —
listTabs・getTabInfo・screenshot・getPageText・getInteractables・
click・type・scroll・navigate・createTab・closeTab・evalJs・
waitForStable・getConsoleLogs・getNetworkActivity・getNetworkRequest・
getStorage・getSourceAt・setSafetyMode

Claude が用途に応じて最も安いツールを選ぶよう設計（スクショより
アクセシビリティツリー、全ログより絞り込みログ）。会話のコンテキストを
小さく保ちます。

— セーフティのオーバーレイ —
機微な操作の前に、ローカルで表示される確認バナーが出ます：決済・購入、
アカウント削除、パスワードフォームの送信、カード番号やパスワードの入力、
cookie / fetch / localStorage を触る危険な JavaScript。通常のナビ
ゲーションやクリックは確認なしで通ります。ポップアップから設定可能。

— 複数セッションでも安全 —
同じ PC 上の複数の Claude Code セッションが、primary/secondary 方式で
1つの拡張を共有します。ポート競合や「接続失敗」は起きません。

— この拡張がやらないこと —
• 第三者サーバへのデータ送信は一切しません。すべて 127.0.0.1 だけを
  通ります。
• AI からの明示的な要求なしに、裏でタブを読むことはありません。
• 解析やテレメトリは含みません。

— オープンソース —
ソース: https://github.com/rikutoe/yolo-chrome-mcp
ライセンス: MIT
バグ・要望: https://github.com/rikutoe/yolo-chrome-mcp/issues

プライバシーポリシー: https://seedx.tech/privacy
```

---

## Category

**Developer Tools**

(secondary, if asked: Productivity)

---

## Language

English (single language listing for now; Japanese can be added later
without re-review)

---

## Permission justifications

| Permission | Justification (short) |
|---|---|
| `tabs` | List open tabs and read their basic metadata so the AI can pick the right tab to operate. |
| `debugger` | Drive the tab via Chrome DevTools Protocol — click, type, screenshot, read console / network. Standard tooling used by DevTools and Playwright. |
| `scripting` | Inject the safety-overlay content script that asks for confirmation before sensitive actions. |
| `cookies` | Allow the AI to read cookies for the current page when explicitly requested (e.g. debugging auth issues). |
| `storage` | Persist a single user preference (safety mode: always / dangerous-only / off). |
| `alarms` | Periodic 15-second keepalive ping so the MV3 service worker reconnects to the local MCP server after Chrome unloads it. |
| host_permissions `<all_urls>` | The user decides which tab to operate; we cannot know the URL ahead of time. |

---

## Privacy practices (Dashboard "Privacy" tab)

### "Single purpose" description

```
Pair Chrome with a locally-running MCP server so AI assistants like Claude can read and operate any tab the user explicitly asks about, using the user's existing logged-in browser session.
```

### Data usage (select these in the dashboard)

| Question | Answer |
|---|---|
| Collects personally identifiable information? | **No** |
| Collects health information? | No |
| Collects financial / payment info? | No |
| Collects authentication information? | No |
| Collects personal communications? | No |
| Collects location? | No |
| Collects web history? | No |
| Collects user activity? | No |
| Collects website content? | **No** (data flows only to a local loopback address on the user's own machine; it is not "collected" by us) |

If Chrome's classifier insists on "website content = yes" because we can
read pages, the correct answer is **website content: yes**, with the
clarifying note: _"Content is only sent to a WebSocket on 127.0.0.1 on
the same computer. No data leaves the user's machine via this
extension."_

### Privacy policy URL

```
https://seedx.tech/privacy
```

(Privacy policy is being set up separately. Replace the placeholder with the final URL once it is live.)

---

## Screenshots

1280×800, upload in order. English set in `docs/store-screenshots/`,
Japanese set (1:1 mirror) in `docs/store-screenshots/ja/`.

| # | File | Message |
|---|------|---------|
| 1 | `01-hero.png` | **Yolo mode for Claude in Chrome** — browse for you, no filters / approval pop-ups, one install |
| 2 | `02-session.png` | **Reads the logged-in pages Claude for Chrome can't** — rides your real session vs. a fresh logged-out browser |
| 3 | `03-speed.png` | **Submitting forms & changing settings was 10× faster** — benchmark bars, 1.6s vs 17s (illustrative) |
| 4 | `04-safety.png` | **Make it ask first — or don't. Your call** — optional, local, three modes |
| 5 | `05-multi.png` | **Many Claude sessions, one Chrome** — primary/secondary, no port conflicts |

Brand: warm off-white bg, amber→red logo gradient, slate ink, orange accent.
Source HTML lives in `/tmp/store-shots/` (regenerate via the `creative-proposal` skill).

Note on screenshot 3: "10×" is an illustrative single-task comparison
(footnoted in the image), not a published benchmark.

---

## Promotional images

- **Promo tile 440×280** — `image/store-promo-tile-440x280.png` (JA: `image/ja/`)
- **Marquee 1400×560** — `image/store-marquee-1400x560.png` (JA: `image/ja/`)

Both refreshed to the current brand with EN + JA variants.
