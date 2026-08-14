# コマンドリファレンス

`context-grill --help` の内容に、実際に使うときの判断基準と例を足したものです。
対象（sources）の書き方は [usage.md](./usage.md)、全体の設計思想は [README.md](./README.md) を参照してください。

---

## 全体像

```
init / resolve  →  sync  →  search / scan / ask
   設定を作る      索引を作る      使う
```

困ったら `doctor`（環境チェック）と `privacy`（送信先の確認）。

---

## コマンド一覧

| コマンド | 何をするか | LLM | 外部通信 |
| --- | --- | --- | --- |
| `init` | `context-grill.config.json` のひな形を作成 | 不使用 | なし |
| `resolve <URL...>` | ブラウザのURLから sources 定義を生成（`--add` で設定に追記） | 不使用 | あり |
| `sync` | ソースを取得して索引を再構築 | 不使用 | あり |
| `build` | 取得済みキャッシュから索引だけ再構築 | 不使用 | なし |
| `status` | 索引とソースの状態を表示 | 不使用 | なし |
| `search <クエリ>` | ハイブリッド検索 | 不使用 | なし |
| `scan` | 静的解析（毎回同じ結果） | 不使用 | なし |
| `ask <指示>` | 証拠付きで調査・回答を生成 | **使用** | あり |
| `tasks` | 利用可能なタスク種別を表示 | 不使用 | なし |
| `mcp` | MCP サーバーとして起動（stdio） | — | — |
| `doctor` | 実行環境と設定の健全性チェック | 不使用 | なし |
| `privacy` | どのデータがどこへ送られるかを表示 | 不使用 | なし |

APIキーが要るのは `ask` だけです（`--dry-run` なら不要）。`sync` は埋め込みを有効にした場合のみ埋め込みAPIを使います。

---

## 共通オプション

| オプション | 説明 |
| --- | --- |
| `-c, --config <path>` | 設定ファイルのパス |
| `--source <id>` | 対象ソースを限定（カンマ区切り） |
| `--json` | JSON で出力 |
| `--log <level>` | `silent` / `error` / `warn` / `info` / `debug` |
| `--offline` | 一切の外部通信を禁止（`search` / `scan` / `--dry-run` のみ動作） |

`--offline` は、閉じたネットワークで「本当に何も出ていかないこと」を強制したいときに使います。

---

## sync — 索引を作る

```bash
context-grill sync                 # 差分同期（通常はこれ）
context-grill sync --full          # キャッシュを無視して全件再取得
context-grill sync --no-embed      # 埋め込み生成をスキップ
context-grill sync --source repo   # 特定ソースだけ
```

対象リポジトリやページが更新されたら再実行します。埋め込みは内容ハッシュ単位でキャッシュされるため、2回目以降は変更分しか課金されません。

設定（`include` / `exclude` など）だけ変えた場合は、取得済みキャッシュから再構築する `build` で足ります（ネットワーク不要）。

---

## search — 検索する

```bash
context-grill search "リトライ 上限"
context-grill search "pipeline.ts" -k 40
```

| オプション | 説明 |
| --- | --- |
| `-k, --top <n>` | 返す件数（既定 20） |
| `--raw` | 墨消しを無効化して原文を表示（取り扱い注意） |

**コツ**: 日本語の設計文書はキーワードが密なぶんスコアが高くなりやすく、実装コードが埋もれることがあります。コードを探すときは、ファイル名や識別子（`pipeline.ts`、`similarity_threshold` など）で引くと当たりやすくなります。

---

## scan — 静的解析

```bash
context-grill scan
context-grill scan --severity high
context-grill scan --severity medium --out scan.md
```

| オプション | 説明 |
| --- | --- |
| `--severity <lv>` | `critical` / `high` / `medium` / `low` / `info`（既定 low 以上） |
| `--out <file>` | 結果を書き出す |

ルールベースなので毎回同じ結果になります。CI に組み込むならこれが向いています。

---

## ask — 調査・回答を生成する

```bash
context-grill ask "決済リトライの仕様を整理して" --task spec
context-grill ask "500 エラーの原因を調べて" --task bug --effort deep
context-grill ask "認証まわりのリスク" --task security --dry-run --out bundle.md
```

| オプション | 説明 |
| --- | --- |
| `-t, --task <id>` | `spec` / `bug` / `security` / `static` / `design`（既定 spec） |
| `-e, --effort <lv>` | `low` / `normal` / `deep`（既定 normal） |
| `-m, --model <name>` | モデルを一時的に上書き |
| `--dry-run` | LLM を呼ばずにプロンプト+証拠バンドルのみ生成（トークン 0） |
| `--out <file>` | レポートの保存先 |

### --task の選び方

| task | 用途 | 出力される item の種類 |
| --- | --- | --- |
| `spec` | 現状の仕様を整理する。実装と文書の食い違いを洗う | requirement / behavior / constraint / data / interface / dependency / gap |
| `bug` | 不具合の原因を追う | observation / reproduction / hypothesis / root_cause / impact / fix_candidate / ruled_out |
| `security` | セキュリティリスクを評価する | risk / exposure / control / gap / ruled_out |
| `static` | コード品質・技術的負債を見る | defect / smell / debt / dependency_risk / test_gap / ruled_out |
| `design` | 新機能の設計。既存の規約・影響範囲を証拠で裏付ける | requirement / decision / component / interface / data_model / migration / impact / risk / alternative / open_design_question |

`context-grill tasks` でも確認できます。

### --effort の選び方

| effort | 検索クエリ数 | 最終証拠数 | 証拠トークン |
| --- | --- | --- | --- |
| `low` | 3 | 14 | 20,000 |
| `normal` | 6 | 28 | 55,000 |
| `deep` | 12 | 56 | 110,000 |

軽く当たりを付けるなら `low`、本気で洗い出すなら `deep`。証拠が足りないと結論が `open_questions` に流れるので、指摘が薄いと感じたら上げてください。

### --dry-run の使いどころ

LLM を呼ばずに、送るはずだったプロンプト一式（契約・証拠・質問）をファイルに書き出します。

- **APIキーがなくても使える**。生成された `bundle.md` を任意の LLM に貼れば同じことができます
- **外部送信ゼロ**。閉じたネットワークでも動きます
- 送信前に「何が外に出るか」を目視確認できます

```bash
context-grill ask "設計に穴がないか検証して" --task spec --effort deep --dry-run --out bundle.md
```

`--out` を付けない場合は `.context-grill/runs/<日時>-<タスク>-<ハッシュ>/bundle.md` に出力され、実行後にパスが表示されます。

---

## 実行結果の中身

`ask` を実行すると `.context-grill/runs/<日時>-<タスク>-<ハッシュ>/` に3つのファイルが残ります。

| ファイル | 内容 |
| --- | --- |
| `report.md` | 最終レポート（全主張に一次資料リンク付き） |
| `evidence.json` | 提示した証拠パック。なぜその結論になったかを監査できる |
| `meta.json` | 索引キー・モデル・タスク種別など、再現性のための情報 |

`--dry-run` の場合は `report.md` の代わりに `bundle.md` が出ます。

---

## よく使う組み合わせ

**証拠が薄いと感じたとき**

```bash
context-grill ask "..." --effort deep
```

**特定のファイルを必ず証拠に入れたいとき**

指示にファイル名や関数名を書くと、検索クエリがそこに寄ります。

```bash
context-grill ask "pipeline.ts の4態分岐と rag.ts の閾値判定を検証して" --task spec --effort deep
```

**外部に何も出さずに使いたいとき**

```bash
context-grill sync            # 取得だけ先に済ませておく
context-grill --offline search "..."
context-grill --offline ask "..." --dry-run --out bundle.md
```

**特定のソースだけ見たいとき**

```bash
context-grill ask "..." --source repo        # GitHub だけ
context-grill ask "..." --source wiki,repo   # 複数指定
```

---

## 困ったとき

```bash
context-grill doctor      # 環境・設定・送信許可ホストを一括チェック
context-grill privacy     # 何がどこへ送られるかを事前確認
context-grill status      # 索引の状態を確認
```

`doctor` で `✗` が出ている項目のうち、使う機能に関係するものだけ解消すれば十分です（`ask` を使わないなら `ANTHROPIC_API_KEY` 未設定は問題ありません）。

外部通信の実績は `.context-grill/egress.log` に残ります。
