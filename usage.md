# 対象の指定方法（リポジトリ / Confluence ページ）

grounded に「どのリポジトリ・どのページを読ませるか」を設定する手順です。

---

## 基本：URL をそのまま貼るだけ

`grounded resolve` にブラウザからコピーした URL を渡すと設定を生成し、`--add` で設定ファイルに追記します。

```bash
grounded resolve "https://github.com/acme/api-service/tree/develop/services/payment" \
                 "https://acme.atlassian.net/wiki/spaces/ENG/pages/393217/決済仕様" --add
grounded sync
```

上の例だと、GitHub は「develop ブランチの `services/payment` 配下だけ」、Confluence は「そのページと配下ツリー」という設定が自動で作られます。

`--add` を付けなければ、貼り付け用の JSON を表示するだけです（設定ファイルは変更されません）。

```bash
grounded resolve "https://github.com/acme/api-service"          # 確認のみ
grounded resolve "https://github.com/acme/api-service" --add    # 設定に追記
grounded resolve "https://github.com/acme/api-service" --json   # 機械可読な出力
```

---

## GitHub

`include` / `exclude`（glob）で範囲を決めます。モノレポの一部だけ、という指定が普通にできます。

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
  "priority": 1.0,
  "auth": { "tokenEnv": "GITHUB_TOKEN" },
  "issues": { "enabled": true, "limit": 200 },
  "pulls":  { "enabled": true, "limit": 100 }
}
```

- **`ref`** はブランチ / タグ / コミット。省略時は既定ブランチ
- **`mode`** は `clone`（既定・大量ファイル向け）か `api`（少数ファイルだけ取りたいとき）
- 手元にクローン済みなら `"path": "/Users/me/work/api-service"`（**読み取り専用**、`repo` 不要）
- **`issues` / `pulls`** を `enabled: true` にすると Issue・PR 本文も一次資料になります（バグ調査で効きます）
- 複数リポジトリは `sources` に並べるだけ。`priority` で信頼度に差を付けられます

---

## Confluence（4 通り）

範囲の決め方は上から優先されます。

### A. ページを名指し（URL 直貼り）— 一番よく使う形

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
`pageIds: ["393217"]` のように ID 直指定も可能です。

### B. 条件で絞る（ラベル / タイトル / 更新日）

```json
{
  "id": "adr",
  "type": "confluence",
  "baseUrl": "https://acme.atlassian.net/wiki",
  "spaceKey": "ENG",
  "labels": ["spec", "adr"],
  "titleContains": "設計",
  "updatedWithinDays": 365,
  "limit": 300,
  "auth": { "emailEnv": "ATLASSIAN_EMAIL", "tokenEnv": "ATLASSIAN_API_TOKEN" }
}
```

### C. 任意の CQL

```json
{
  "id": "spec",
  "type": "confluence",
  "baseUrl": "https://acme.atlassian.net/wiki",
  "cql": "space = ENG AND label = spec AND type = page ORDER BY lastmodified DESC",
  "limit": 300,
  "auth": { "emailEnv": "ATLASSIAN_EMAIL", "tokenEnv": "ATLASSIAN_API_TOKEN" }
}
```

### D. スペース全体

```json
{
  "id": "wiki",
  "type": "confluence",
  "baseUrl": "https://acme.atlassian.net/wiki",
  "spaceKey": "ENG",
  "limit": 500,
  "auth": { "emailEnv": "ATLASSIAN_EMAIL", "tokenEnv": "ATLASSIAN_API_TOKEN" }
}
```

### どのモードでもタイトルで最終フィルタできる

```json
{ "include": ["*仕様*", "*設計*"], "exclude": ["*議事録*", "*日報*", "*WIP*"] }
```

### 注意点

- **`baseUrl` は `/wiki` まで**含めてください（Cloud の場合）
- 短縮リンク（`/wiki/x/AbCdEf`）は URL だけでは解決できません。ページを開いて `/wiki/spaces/.../pages/<数字>/...` 形式の URL をコピーしてください
- 差分同期はページの `version.number` で判定するため、更新のないページは再取得されません
- 対象は Confluence Cloud（REST API v2 / v1 検索）です。Server / Data Center は API が異なります

---

## Jira

`jql` で指定します。

```json
{
  "id": "jira",
  "type": "jira",
  "baseUrl": "https://acme.atlassian.net",
  "jql": "project = ENG AND updated >= -180d ORDER BY updated DESC",
  "limit": 300,
  "auth": { "emailEnv": "ATLASSIAN_EMAIL", "tokenEnv": "ATLASSIAN_API_TOKEN" }
}
```

チケット URL（`.../browse/ENG-1234`）を `grounded resolve` に渡すと `key = ENG-1234` の形になります。

---

## ローカルディレクトリ

社内ファイルサーバから落とした設計書などを混ぜたい場合。

```json
{ "id": "designdocs", "type": "local", "path": "./design-docs", "include": ["**/*.md"] }
```

---

## 設定後の流れ

```bash
grounded sync      # 取得 → 索引構築（設定を変えたらこれ）
grounded build     # 取得済みキャッシュから索引だけ再構築（ネットワーク不要）
grounded status    # 何が何件取り込まれたかを確認
grounded privacy   # どのデータがどこへ送られるかを確認
```

`grounded status` の出典別件数が想定と違う場合は、`include` / `exclude` / `limit` を見直してください。

意図した資料が検索に出てくるかは、LLM を呼ばずに確認できます。

```bash
grounded search "返金 リトライ 上限"        # 検索だけ（トークン消費ゼロ）
grounded ask "..." --dry-run               # 送信予定の証拠とプロンプトを全部表示
```

---

## よくある調整

| 状況 | 対処 |
| --- | --- |
| 関係ないページが大量に入る | `exclude` にタイトル glob を追加、または `labels` / `pageIds` で絞る |
| 目的のコードが検索に出ない | `include` が狭すぎないか確認。`grounded search` で直接確認する |
| 同期が遅い / 重い | `maxFiles`、`limit`、`include` を絞る。`mode: "api"` は少数ファイル向け |
| 資料が古い | `grounded sync`（差分同期なので更新分だけ取り直します） |
| 文書と実装で信頼度に差がある | `priority` を調整（大きいほど検索で優遇） |
