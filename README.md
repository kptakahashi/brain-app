# Brain — スマホ完結版 セットアップ

PCもレンタルサーバーも不要。**月額0円**でスマホだけで動きます。

```
[スマホ] Brainアプリ(GitHub Pagesに常設・無料)
   ├ 鍛える / 聴く …… 端末内で完結(電波がなくても動く)
   └ 記録 / リサーチ … 依頼をGitHubに書き込む
                          ↓
[GitHub] Vault + 依頼キュー + カード + 音声  ← ここが全ての中心
                          ↓
[Claude Codeクラウド] 依頼を処理してVaultへ書き戻す(Anthropic側で動く。PC不要)
                          ↓
[PC] 開いた時にObsidianが追いつくだけ(完全に任意)
```

---

## セットアップ(初回のみ・15分)

### ステップ1: アプリ置き場のリポジトリを作る

1. GitHubで **新しいリポジトリ** を作る
   - 名前: `brain-app`
   - **Public**(公開)を選ぶ ← GitHub Pagesを無料で使うため
   - READMEなどは追加しない(空のまま)

> 公開されるのは**アプリの画面のコードだけ**です。Vaultの中身・トークンは一切含まれません。

### ステップ2: アプリを置く

PCで(1回だけ):

```bash
cd C:\Brain\web
git remote add origin https://github.com/<あなたのユーザー名>/brain-app.git
git branch -M main
git push -u origin main
```

### ステップ3: GitHub Pagesを有効にする

1. `brain-app` リポジトリ → **Settings** → 左メニューの **Pages**
2. Source: **Deploy from a branch**
3. Branch: **main** / **/(root)** → **Save**
4. 1〜2分待つと `https://<ユーザー名>.github.io/brain-app/` で開けるようになります

### ステップ4: アクセストークンを作る

アプリがあなたのVault(privateリポジトリ)を読み書きするための鍵です。

1. GitHub → 右上のアイコン → **Settings**
2. 左下の **Developer settings** → **Personal access tokens** → **Fine-grained tokens**
3. **Generate new token**
   - Token name: `brain-app`
   - Expiration: 1年など(切れたら作り直して入れ直すだけ)
   - Repository access: **Only select repositories** → **Thinking**(Vaultのリポジトリ)を選ぶ
   - Permissions → Repository permissions → **Contents** を **Read and write** に変更
4. **Generate token** → 表示された `github_pat_...` をコピー

> このトークンは **Thinkingリポジトリの中身だけ** を読み書きできます。他のリポジトリやアカウント設定には触れません。
> スマホを紛失した場合は、上の画面から即座に無効化できます。

### ステップ5: スマホで開く

1. Chromeで `https://<ユーザー名>.github.io/brain-app/` を開く
2. ユーザー名・リポジトリ名(`Thinking`)・トークンを入力 → **接続する**
3. メニュー → **ホーム画面に追加**

これで完了です。以後、電波があってもなくてもアイコンから起動できます。

---

## AI処理を動かす(2通り)

### A. その場で処理する(即時)

1. スマホの **Claudeアプリ** → **Code** タブ
2. リポジトリ `Thinking` を選ぶ
3. こう送る:
   > **brain/WORKER.md に従って未処理の依頼を全部処理して**

数分で、記録の判定・リサーチ・カード生成などが実行され、Vaultに反映されます。

### B. 自動で処理する(定期実行)

Claude Codeの **ルーティン**(定期実行)に上と同じ文言を登録すれば、
1日数回、自動で依頼が処理されます。放っておいても溜まりません。

### リサーチを使うなら:ネットワーク設定を1回だけ変更

クラウドセッションは初期状態だと外部サイトへの接続が制限されています。

1. claude.ai/code → 環境(Environment)の設定
2. **Network access** を **Full** にする(または調べたいドメインを許可)

これでWeb検索・論文APIの利用ができるようになります。

---

## 使い分け

| したいこと | どこで |
|---|---|
| 移動中に気づきを吹き込む | Brainアプリ「記録」 |
| 5分の想起トレーニング | Brainアプリ「鍛える」(電波不要) |
| 通勤中に音声で学ぶ | Brainアプリ「聴く」(事前DLで電波不要) |
| リサーチ・カード追加を頼む | Brainアプリで依頼 → Claudeアプリで実行 |
| じっくり思考セッション | Brainアプリ「対話」→ Claudeアプリへ引き継ぎ |
| Vaultをじっくり読む・編集 | Obsidian(スマホ/PC) |

---

## PC版との関係

`C:\Brain\app` のPC版サーバーは今後も使えます。役割分担:

- **スマホ版(これ)**: 日常の記録・訓練・視聴。どこでも動く
- **PC版**: 音声の一括生成など重い処理。開いた時だけ

両者は `brain/` フォルダ(GitHub経由)で**同じデータを共有**するので、
どちらで練習してもカードの学習履歴は1つに保たれます。

---

## 困ったとき

| 症状 | 対処 |
|---|---|
| 画面が崩れた | ⚙ → 「アプリを最新に更新」 |
| 「トークンが無効」 | ⚙ → 「接続をやり直す」。トークンの期限切れなら作り直す |
| 未送信が溜まる | 電波が戻れば自動送信されます。⚙ →「今すぐ同期」でも可 |
| 依頼が処理されない | Claudeアプリで「brain/WORKER.md に従って…」を送る |
| ホーム画面のアイコンが古い | 一度削除 → Chromeで開き直して追加し直す |

## データはどこにあるか

- **Vault本体**: `vault/メモ/`(GitHub・Obsidianと同じもの)
- **カード・学習履歴**: `brain/cards.json`
- **音声**: `brain/audio/`
- **依頼の記録**: `brain/tasks/`

すべてGitHubにあるため、履歴が残り、いつでも巻き戻せます。

## 開発(PC で画面を直すとき)

コードの変更は PR にし、diff を読んでからマージする(Thinking の `decisions/0008` と同じ考え方)。JS は ESLint が止める。いちばんの狙いは XSS: この画面は GitHub の鍵を端末に保存しているので、データから作る HTML は必ず `esc()` を通す。

```bash
npm ci                                  # 初回だけ(Node.js LTS が要る)
git config core.hooksPath .githooks     # 初回だけ。JS を変えた commit で ESLint が走る
npm run lint                            # 完了と言う前に必ず通す。同じものが CI(.github/workflows/lint.yml)でも走る
```

- 規則は `eslint.config.mjs`。例外は 1 行ずつ `// eslint-disable-next-line 規則 -- 理由` で書く(理由が無いと止まる。要らなくなった例外も止まる)
- `innerHTML` の例外 19 か所は、2026-10-30 に全部読んで、差し込む値が `esc()` 済みか数値・固定文字であることを確かめたもの
- 2 枚目の壁は `index.html` の CSP(`script-src 'self'`)。外さない
