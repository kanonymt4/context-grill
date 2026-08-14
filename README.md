# context-grill

GitHub リポジトリと Atlassian（Confluence / Jira）の資料を「一次資料」として登録し、
**仕様の整理・バグ調査・セキュリティリスク評価・静的解析・新機能設計** を
**根拠（証拠 ID + 行番号 + パーマリンク）付き** で行う CLI / MCP サーバーです。

- **依存パッケージゼロ**（Node.js 20+ と、任意で `git` だけ）。ディレクトリごとコピーすればどの PC・サーバー・CI でも動きます
- **推測禁止**：モデルの出力は機械的に検証され、証拠のない主張・存在しない証拠 ID・捏造した引用は自動で除去されます
- **モデル非依存の品質**：証拠の選定と検証は LLM を一切使わないため、モデル・実行回数が変わっても根拠と合否基準は同じ
- **トークン効率**：ハイブリッド RAG（BM25 + ベクトル）＋ 予算パッキング ＋ プロンプトキャッシュ ＋ 埋め込みキャッシュ

---

## 1. なぜ「同じ品質」になるのか

処理を 6 段階に分け、**LLM が関与するのは 5 段階目だけ**にしています。

| 段階 | 処理 | LLM | 決定性 |
| --- | --- | --- | --- |
| 1 | 資料の取得（GitHub / Confluence / Jira） | 不使用 | ハッシュとバージョンで管理 |
| 2 | チャンク分割（コードは行番号保持） | 不使用 | 完全に決定的 |
| 3 | クエリ計画（タスク別テンプレート＋日英用語辞書） | **不使用** | 同じ指示 → 常に同じクエリ |
| 4 | ハイブリッド検索 → RRF 融合 → MMR → 予算パッキング | 不使用 | 同じ索引 → 常に同じ証拠パック |
| 5 | 証拠の解釈（構造化 JSON を強制） | **使用** | ここだけモデル依存 |
| 6 | 機械検証 → 修復ループ → 除去 | 不使用 | 合否基準は常に同じ |

段階 6 の検証内容：

- スキーマ違反
- 存在しない証拠 ID の引用（`E99` など）
- **逐語引用の実在照合**（`quotes[].text` が証拠本文に literal に含まれるか。ハルシネーション検出の要）
- 証拠が付いていない主張
- 「おそらく」「一般的には」等の推測表現 × 高確度の組み合わせ

違反した項目はプロンプトに違反理由を添えて再生成（既定 2 回まで）し、
それでも通らなければ本文から除去して「棄却された主張」欄に理由付きで記録します。
つまり**弱いモデルを使っても、間違った断定がユーザーに届かない**設計です。

さらに、秘密情報・インジェクション・TLS 無効化・脆弱な暗号などの検出は
LLM を使わない静的ルールで行うため、**どのモデルでも必ず同じ指摘が出ます**（品質の下限）。

---

## 2. セットアップ

```bash
# Node.js 20 以上があれば OK（npm install は不要 — 依存パッケージがありません）
node --version

# 任意の場所に配置してパスを通す（またはそのまま node bin/context-grill.js で実行）
npm link          # 省略可
context-grill doctor   # 環境チェック
```

プロジェクトのルートで初期化します。

```bash
context-grill init          # context-grill.config.json と .env.example を作成

# 対象リポジトリ / Confluence ページの URL を貼るだけで設定を生成（詳細は 7 章）
context-grill resolve "https://github.com/acme/api-service" \
                 "https://acme.atlassian.net/wiki/spaces/ENG/pages/393217/決済仕様" --add

$EDITOR context-grill.config.json
cp .env.example .env && $EDITOR .env
context-grill sync          # 資料を取得して索引を構築
context-grill status
```

### 認証情報

| 変数 | 用途 |
| --- | --- |
| `GITHUB_TOKEN` | private リポジトリの clone / API 取得 |
| `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` | Confluence / Jira（[API トークン発行](https://id.atlassian.com/manage-profile/security/api-tokens)） |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `LLM_API_KEY` | 推論に使うプロバイダのもの 1 つ |

`.env` は自動で読み込まれます（既存の環境変数は上書きしません）。

---

## 3. 使い方

```bash
# 仕様の整理
context-grill ask "決済の返金フローの仕様を実装ベースで整理して" --task spec

# バグ調査（深く探す）
context-grill ask "本番で断続的に 504 が出る原因を調べて" --task bug --effort deep

# セキュリティリスク
context-grill ask "認証・認可まわりのリスク" --task security --source api,wiki

# 静的解析（LLM が誤検知を仕分ける）
context-grill ask "リリース前に直すべき品質問題" --task static

# 新機能設計（既存の規約・制約を証拠で裏付ける）
context-grill ask "サブスク解約の予約機能を追加したい" --task design --effort deep
```

### トークンを一切使わないコマンド

```bash
context-grill search "リトライ 上限"     # ハイブリッド検索だけ（LLM 不使用）
context-grill scan --severity medium     # 静的解析だけ（LLM 不使用・毎回同じ結果）
context-grill ask "..." --dry-run        # 証拠パック + プロンプト一式を生成して終了
```

`--dry-run` が出力する `bundle.md` は、そのまま任意のチャット（Claude / ChatGPT / ローカル LLM）に
貼り付けられる形になっています。**API キーが無い環境でも、証拠収集だけをこのツールに任せられます。**

### 出力

各実行は `.context-grill/runs/<日時>-<タスク>-<ハッシュ>/` に保存されます。

```
report.md      最終レポート（Markdown・全主張に一次資料リンク付き）
result.json    構造化結果 + 検証統計 + 実行メタデータ
evidence.json  提示した証拠パック（再現・監査用）
static.json    静的解析の生データ
```

---

## 4. MCP サーバーとして使う

Claude Code / Cowork / Cursor などから、この索引を直接使えます。

```bash
context-grill mcp     # stdio
```

設定例（`.mcp.json` / `claude_desktop_config.json`）:

```json
{
  "mcpServers": {
    "context-grill": {
      "command": "node",
      "args": ["/abs/path/to/context-grill/bin/context-grill.js", "mcp", "--config", "/abs/path/to/your-project/context-grill.config.json"],
      "env": { "GITHUB_TOKEN": "...", "ATLASSIAN_EMAIL": "...", "ATLASSIAN_API_TOKEN": "..." }
    }
  }
}
```

提供ツール：

| ツール | 用途 |
| --- | --- |
| `context_grill_status` | 索引済み資料の範囲を確認 |
| `context_grill_search` | ハイブリッド検索（行番号・URL 付き） |
| `context_grill_evidence_pack` | 指示に対する証拠パック + 契約 + 出力スキーマを一括取得 |
| `context_grill_verify` | ホスト側モデルが書いた回答を証拠に照らして機械検証 |
| `context_grill_static_scan` | LLM 非依存の静的解析 |
| `context_grill_fetch` | 証拠やファイルの指定行を取得 |
| `context_grill_run_task` | 設定済みモデルで完結実行 |
| `context_grill_sync` | 資料の再取得 |

**推奨フロー**：`context_grill_evidence_pack` → ホストのモデルが JSON を生成 → `context_grill_verify` → 合格した結果だけを提示。
これによりホストのモデルが何であっても、**証拠の選定と合否判定は同一**になります。

---

## 5. トークン消費の抑え方

| 仕組み | 効果 |
| --- | --- |
| チャンク単位の RAG | ファイル全体ではなく該当箇所（100 行前後）だけを送る |
| RRF + MMR | 冗長な重複チャンクを落として情報密度を上げる |
| 予算パッキング | `effortPresets` のトークン上限で機械的に打ち切り |
| プロンプトキャッシュ | 契約文と証拠ブロックに `cache_control` を付与（Anthropic） |
| 埋め込みキャッシュ | 内容ハッシュ単位で永続化。再同期時の埋め込みコストはゼロ |
| 差分同期 | Confluence は `version.number`、GitHub は shallow fetch |
| `--dry-run` / `search` / `scan` | LLM を呼ばずに調査を進める |

`--effort low|normal|deep` で、証拠量（20k / 55k / 110k トークン）とクエリ数だけが変わります。
**契約・スキーマ・検証基準は effort によって変わりません**（＝ 工数を変えても品質基準は同一）。

---

## 6. 検索の仕組みと日英ギャップ

- **BM25**：コード識別子に強い。`camelCase` / `snake_case` を部分語に分解して索引化
- **日本語**：形態素解析器に依存せず 1-gram + 2-gram で索引化（追加依存なしで動く）
- **用語辞書ブリッジ**：`返金 → refund` `リトライ → retry` など約 100 組の静的辞書でクエリを拡張。
  日本語の設計書と英語のコードを埋め込みなしで突き合わせられます（`retrieval.glossaryBridge`）
- **ベクトル検索（任意）**：`retrieval.embedding.provider` を `openai` / `voyage` / `openai-compat` にすると
  言い換えへの耐性が上がります。無効でも同じ手順で動作します

---

## 7. 対象の指定方法（リポジトリ / Confluence ページ）

> コマンドとオプションの一覧・使用例は **[commands.md](./commands.md)**、
> 実践的な設定例と調整の勘所は **[usage.md](./usage.md)** にまとめてあります。

一番簡単なのは **ブラウザの URL をそのまま貼る**方法です。

```bash
context-grill resolve "https://github.com/acme/api-service/tree/develop/services/payment" \
                 "https://acme.atlassian.net/wiki/spaces/ENG/pages/393217/決済仕様" --add
```

`--add` を付けると `context-grill.config.json` の `sources` に直接追記されます（付けなければ貼り付け用の JSON を表示するだけ）。
あとは `context-grill sync` で取り込まれます。

### 7.1 GitHub の指定

| 貼る URL | 生成される設定 |
| --- | --- |
| `github.com/acme/api` | リポジトリ全体（`src/**`, `docs/**` などの既定 include） |
| `github.com/acme/api/tree/develop/services/payment` | `ref: "develop"` + `include: ["services/payment/**"]` |
| `github.com/acme/api/blob/main/src/auth.js` | `include: ["src/auth.js"]` |
| `git.corp.example.com/acme/api` | GitHub Enterprise Server として `host` / `apiBaseUrl` を設定 |

手で書く場合:

```json
{
  "id": "api",
  "type": "github",
  "repo": "acme/api-service",
  "ref": "main",
  "mode": "clone",
  "include": ["src/**", "docs/**", "*.md", "package.json"],
  "exclude": ["**/*.test.ts", "**/__snapshots__/**"],
  "maxFiles": 5000,
  "auth": { "tokenEnv": "GITHUB_TOKEN" },
  "issues": { "enabled": true, "limit": 200 },
  "pulls":  { "enabled": true, "limit": 100 }
}
```

- **`include` / `exclude`** がリポジトリ内の絞り込みです（glob）。モノレポなら `include: ["services/payment/**"]` のように一部だけ取り込めます
- **`ref`** はブランチ / タグ / コミット。省略時は既定ブランチ
- **`mode`** は `clone`（既定・大量ファイル向け）か `api`（少数ファイルだけ取りたいとき）
- **`issues` / `pulls`** を有効にすると、Issue / PR 本文も一次資料になります（バグ調査で効きます）
- 既に手元にクローン済みなら `"path": "/Users/me/work/api-service"` を指定できます（**読み取り専用**。`repo` は不要）
- 複数リポジトリは `sources` に並べるだけ。`priority` で信頼度に差を付けられます

### 7.2 Confluence の指定（4 通り）

範囲の決め方は上から優先されます。

**A. ページを名指し（URL 直貼りが可能）** — 一番よく使う形

```json
{
  "id": "spec",
  "type": "confluence",
  "baseUrl": "https://acme.atlassian.net/wiki",
  "pageUrls": [
    "https://acme.atlassian.net/wiki/spaces/ENG/pages/393217/決済仕様",
    "https://acme.atlassian.net/wiki/spaces/ENG/pages/524288/認証設計"
  ],
  "includeDescendants": true,
  "maxDepth": 5,
  "limit": 200,
  "auth": { "emailEnv": "ATLASSIAN_EMAIL", "tokenEnv": "ATLASSIAN_API_TOKEN" }
}
```

`includeDescendants: true` で**そのページの配下ツリーごと**取り込みます（`maxDepth` で深さ制限）。
`pageIds: ["393217"]` のように ID 直指定も可。

**B. 条件で絞る（ラベル / タイトル / 更新日 / 任意の CQL）**

```json
{
  "id": "spec",
  "type": "confluence",
  "baseUrl": "https://acme.atlassian.net/wiki",
  "spaceKey": "ENG",
  "labels": ["spec", "adr"],
  "updatedWithinDays": 365,
  "auth": { "emailEnv": "ATLASSIAN_EMAIL", "tokenEnv": "ATLASSIAN_API_TOKEN" }
}
```

`cql` を書けば任意の条件を指定できます（例: `"cql": "space = ENG AND label = spec AND type = page ORDER BY lastmodified DESC"`）。

**C. スペース全体**

```json
{ "id": "wiki", "type": "confluence", "baseUrl": "https://acme.atlassian.net/wiki", "spaceKey": "ENG", "limit": 500 }
```

**D. どのモードでもタイトルで最終フィルタ**

```json
{ "include": ["*仕様*", "*設計*"], "exclude": ["*議事録*", "*日報*", "*WIP*"] }
```

補足:

- `baseUrl` は **`/wiki` まで**含めます（Cloud の場合）
- 短縮リンク（`/wiki/x/AbCdEf`）は URL だけでは解決できません。ページを開いて通常の URL をコピーしてください
- 差分同期はページの `version.number` で判定するため、更新のないページは再取得されません

### 7.3 Jira の指定

```json
{ "id": "jira", "type": "jira", "baseUrl": "https://acme.atlassian.net",
  "jql": "project = ENG AND updated >= -180d ORDER BY updated DESC", "limit": 300 }
```

チケット URL を `context-grill resolve` に渡すと `key = ENG-1234` の形で生成されます。

### 7.4 ローカルディレクトリ

```json
{ "id": "designdocs", "type": "local", "path": "./design-docs", "include": ["**/*.md"] }
```

### 7.5 主要な設定キー

| キー | 既定 | 説明 |
| --- | --- | --- |
| `sources[].type` | — | `github` / `confluence` / `jira` / `local` |
| `sources[].priority` | 定義順 | 検索時の加点。信頼できる資料を上げる |
| `sources[].limit` | 500 | 取り込む最大件数 |
| `retrieval.embedding.provider` | `none` | `none` なら外部への本文送信ゼロ |
| `llm.provider` | `anthropic` | `anthropic` / `openai` / `openai-compat` / `dry` |
| `policy.requireVerbatimQuote` | `true` | 逐語引用の実在照合 |
| `budget.maxRepairs` | `2` | 検証違反時の再生成回数 |

ローカル LLM の例:

```json
{ "llm": { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:32b", "apiKeyEnv": "LLM_API_KEY" } }
```

設定を変えたら `context-grill sync`（取得からやり直し）か `context-grill build`（取得済みキャッシュから索引だけ再構築）を実行します。
取り込み結果は `context-grill status` で件数を確認できます。

## 8. 移植 / チームでの共有

- `.context-grill/`（索引・キャッシュ・実行結果）は自動的に `.gitignore` されます
- 共有するのは `context-grill.config.json` だけ。各自が `context-grill sync` すれば同じ索引ができます
- 索引の再現性キー（`indexKey`）はレポートに記録されるため、**別の人・別のモデルの結果と厳密に比較**できます
- CI で使う例：

```yaml
- run: node context-grill/bin/context-grill.js sync
- run: node context-grill/bin/context-grill.js scan --severity high --json --out scan.json
- run: node context-grill/bin/context-grill.js ask "この PR で増えたセキュリティリスク" --task security --out risk.md
```

### 8.1 npm パッケージとして配布する

git リポジトリへのアクセスを渡さずに、単一ファイルで配布したい場合は `npm pack` を使います。`zip -r` などでディレクトリを丸ごと固めるのは避けてください — `.env`（APIキー）や `.git/` の履歴、`.context-grill/`（索引キャッシュ）まで含まれてしまいます。

`npm pack` は `package.json` の `files` フィールドを許可リストとして参照するため、上記は原理的に含まれません。

```bash
npm pack --dry-run   # 中身を事前確認（何もファイルは生成されない）
npm pack             # context-grill-<version>.tgz を生成
```

受け取った側のインストール：

同梱の `scripts/setup.sh`（macOS / Linux）または `scripts/setup.ps1`（Windows）を、`.tgz` と同じディレクトリに置いて実行すると、Node のバージョン確認・インストール・作業ディレクトリの `init`・`doctor` までを一度に行います。

```bash
sh setup.sh                    # カレントに作業ディレクトリを作る
sh setup.sh ~/work/my-project  # 場所を指定する
```

```powershell
# Windows（実行できない場合は powershell -ExecutionPolicy Bypass -File .\setup.ps1）
.\setup.ps1
```

スクリプトは**シェル設定ファイルの書き換え・`sources` の編集・`.env` への認証情報の記入は行いません**。必要な手順を表示するだけなので、そこはご自身で設定してください。

手動でインストールする場合：

```bash
npm install -g ./context-grill-<version>.tgz
context-grill doctor   # 自分の GITHUB_TOKEN / ANTHROPIC_API_KEY 等を .env に用意してから実行
```

**`npm install -g` で `EACCES` エラーが出る場合**

macOS では npm のグローバルインストール先（`/usr/local/lib/node_modules` など）への書き込み権限がなく、`Error: EACCES: permission denied` になることがあります。`sudo npm install -g ...` でも回避できますが、恒久的に直すなら prefix をユーザー所有のディレクトリに変更するのがおすすめです。

```bash
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g ./context-grill-<version>.tgz
```


配布物に含まれるのは `bin/` `src/` `scripts/` `context-grill.config.example.json` `commands.md` `usage.md` `README.md` のみです。認証情報・索引・作業メモ（`CLAUDE.md`）はどの配布物にも含まれません。

### 8.2 メールで配布する場合の注意

Gmail は添付ファイルの**名前**を見てブロックします。`.js` や `.ps1` などは、アーカイブの中に入っていても検出されます。

実測した挙動は次のとおりです（2026-08 時点）。

| 送るもの | 結果 |
| --- | --- |
| `.tgz` をそのまま添付 | ブロック（中の `.js` が展開・検出される） |
| `.tgz` を暗号化 zip に入れる | 通る（中身は復号できないためスキャンされない） |
| 暗号化 zip に `setup.ps1` を同梱 | **ブロック**（暗号化しても**ファイル名は平文**なので `.ps1` が見える） |
| `setup.ps1` → `setup.ps1.txt` にリネームして同梱 | 通る |

`setup.sh` はブロックリストに含まれないため、そのままで問題ありません。

つまりメールで送るなら、`setup.ps1` だけリネームして暗号化 zip にまとめます。

```bash
mkdir context-grill-dist
cp context-grill-<version>.tgz scripts/setup.sh context-grill-dist/
cp scripts/setup.ps1 context-grill-dist/setup.ps1.txt   # .ps1 のままだと弾かれる
zip -er context-grill-dist.zip context-grill-dist       # パスワードは別経路で伝える
```

受け取った Windows ユーザーには、使う前に `setup.ps1.txt` を `setup.ps1` に戻してもらう必要があります。その旨を書いた案内を同梱しておくと親切です。

なお、受信側が企業のメールゲートウェイを使っている場合は、暗号化アーカイブ自体を隔離するポリシーのこともあります。確実に渡したいなら、クラウドストレージの共有リンクを使うほうが安全です。


---

## 9. セキュリティ（社内非公開リポジトリ／社内 Confluence 前提）

社外に出せない資料を扱う前提で、**外部送信**と**書き込み**の両方を機械的に制御しています。
実際の挙動は `context-grill privacy` で確認でき、通信は `.context-grill/egress.log` に記録されます。

### 9.1 外部へ出るデータ（送信先ホワイトリスト方式）

すべての外部通信は単一のゲート（`src/util/egress.js`）を通ります。
**設定から導出したホスト以外へは、送信そのものが例外になります。**

| 通信 | 送るもの | 既定 |
| --- | --- | --- |
| GitHub / Confluence / Jira | 認証情報のみ（資料は受信方向） | 有効 |
| 埋め込み API | 索引対象チャンクの**本文** | **既定で禁止**（`security.allowEmbeddingUpload` の明示同意が必要） |
| LLM API | 検索でヒットした証拠のみ（全文ではない・墨消し済み） | 有効（`security.allowLlmUpload: false` で全面禁止） |

- HTTP メソッドは `GET` / `HEAD` / `POST` のみ許可。`PUT` / `DELETE` / `PATCH` は例外になります
- `--offline` または `security.networkMode: "offline"` で全通信を拒否できます（`search` / `scan` / `--dry-run` は動作）
- `--dry-run` は LLM を呼ばずにプロンプト一式を出力するため、**何を送るかを送信前に全部読めます**
- 設定値に環境変数の秘密の実値が展開されていた場合（`baseUrl` への混入など）、起動時に拒否します

### 9.2 機密ファイルは索引に入りません

`include` に `**/*` を書いても、次のパターンは**無条件で除外**されます（`security.denySensitivePaths`）。

```
.env / .envrc / *.pem / *.key / *.p12 / *.jks / id_rsa* / id_ed25519* / .ssh/**
.netrc / .npmrc / .git-credentials / .aws/** / .kube/** / kubeconfig
service-account*.json / secrets.* / *.tfstate* / .terraform/** / .htpasswd / *.gpg …（全 57 パターン）
```

`.env.example` などのサンプルは許可されます。シンボリックリンクはたどりません（リポジトリ外の読み出し防止）。

### 9.3 シークレット墨消し（多層防御）

通常のコードや設定に埋め込まれた認証情報は、**外部に出る境界で必ず墨消し**されます。

- 対象: LLM へ送る証拠パック / 埋め込み API へ送る本文 / MCP がホストモデルに返す本文 / 静的解析の検出スニペット / `context-grill search` の出力
- 検出: 秘密鍵ブロック、AWS / GitHub / Slack / Stripe / OpenAI / Anthropic / Google / JWT、URL 埋め込みパスワード、`key = "..."` 形式、`.env` 形式
- `process.env.API_KEY` のような環境変数参照は誤検知しません
- **行数を変えない**実装なので、行番号・逐語引用の検証は壊れません

```
- const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
+ const AWS_KEY = "«REDACTED:AWS_ACCESS_KEY»";
```

ローカルキャッシュ（`.context-grill/cache/`）は静的解析と行番号照合のため原文を保持しますが、
ワークスペースは `0700` で作成され、`.context-grill/.gitignore`（`*`）によりコミット対象になりません。

### 9.4 書き込みリスク（誤コミット・誤更新の防止）

**このツールが書き込む場所は 3 つだけです。**

1. `<workspace>/`（既定 `.context-grill/`）配下
2. `--out` で明示指定したファイル
3. `context-grill init` 実行時の `context-grill.config.json` / `.env.example`（既存があれば `--force` なしでは上書きしません）

git については、実行しうるサブコマンドを許可リストで固定しています。

| 実際に実行される | `clone` / `fetch` / `reset --hard` / `rev-parse` の 4 つのみ |
| --- | --- |
| **到達不能** | `push` `commit` `add` `rm` `checkout` `switch` `clean` `merge` `rebase` `stash` `tag` `submodule` ほか |

- `reset --hard` は **context-grill が作成したクローン**（マーカーファイル `.context-grill-managed` を持ち、ワークスペース内にある）に対してのみ実行されます。既存ディレクトリを見つけた場合は上書きせずエラーになります
- `sources[].path` でローカルの作業リポジトリを指す場合は、`git rev-parse HEAD` しか実行しません（**完全に読み取り専用**。未コミットの変更やブランチに一切触れません）
- Confluence / Jira は参照系 API のみ。ページ作成・更新・削除の実装自体がありません

### 9.5 認証トークンの取り扱い

git 認証は URL・コマンドライン引数・`.git/config` のいずれにも載せず、`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` 環境変数（git 2.31+）経由で渡します。

```
修正前: Command failed: git clone https://x-access-token:ghp_REAL_TOKEN@github.com/... ← ログに漏れる
修正後: Command failed: git clone https://github.com/...                              ← 漏れない
```

- 例外・ログ・監査ログはすべて墨消しを通します（環境変数の実値も落とします）
- 監査ログにクエリ文字列は記録しません
- `context-grill doctor` は環境変数の**名前と設定有無**だけを表示し、値は出しません

### 9.6 プロンプトインジェクション

Confluence ページや Issue に「これまでの指示を無視して〜」と書かれていても実行しないよう、
システム契約と MCP の `instructions` に明示条項を入れています。
検知した場合はモデルに **実行させず `open_questions` へ報告させます**。
またツール群には任意の URL を取得する機能が無く、更新系 API も持たないため、
**注入が成功しても外部送信・データ改変の経路がありません**。

### 9.7 推奨運用

- GitHub は **fine-grained PAT（Contents: Read-only）** を使う
- Atlassian API トークンは閲覧権限のみのアカウントで発行する
- 初回は `context-grill privacy` と `context-grill ask --dry-run` で送信内容を確認してから本番運用に入る
- 完全にローカルで済ませたい場合: `security.networkMode` を通常運用にしつつ `llm.provider: "openai-compat"` でローカル LLM を指定し、`retrieval.embedding.provider: "none"` のままにする
- LLM プロバイダ側の学習利用除外・データ保持ポリシー（Zero Data Retention 等）は別途契約で確認してください。本ツールはそこまでは保証できません

### 9.8 それでも残る制約

- Confluence は Cloud（REST API v2）が対象。Server/Data Center は API が異なります
- 大規模リポジトリでは `include` / `maxFiles` を絞ってください（索引構築時にメモリを使います）
- 静的解析は正規表現ベースで、網羅的な SAST の代替ではありません
- 墨消しは既知パターンに対する多層防御であり、独自形式の秘密を 100% 捕捉するものではありません。機密ファイルの除外（9.2）が第一防衛線です

## 10. テスト

```bash
npm test        # node --test（37 ケース）
```

内訳:

- **機能** — 検証ゲート、チャンクの行番号整合、クエリ計画の決定性、証拠パックの再現性
- **セキュリティ回帰** — 機密ファイルが索引に入らないこと、墨消しが行数を保つこと、許可外ホストへの送信がブロックされること、オフラインモード、更新系メソッドの禁止、破壊的 git サブコマンドが到達不能なこと、管理外ディレクトリを破壊しないこと、トークンが argv/URL に載らないこと、シンボリックリンクをたどらないこと、埋め込み送信の明示同意、設定への秘密値混入の拒否
- **構造的保証** — `src/` 内に egress ゲートを迂回する `fetch` が存在しないこと、git のサブコマンドが 4 つだけであること（将来の変更で穴が空くのを防ぐ）
