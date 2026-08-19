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

`ask --dry-run` で作った証拠パックは、他の AI に渡して議論の材料にもできます
→ [証拠パックを他の AI に渡して壁打ちする](#証拠パックを他の-ai-に渡して壁打ちする)

---

## コマンド一覧

| コマンド | 何をするか | LLM | 外部通信 |
| --- | --- | --- | --- |
| `init` | 設定のひな形とドキュメントを作業ディレクトリに配置 | 不使用 | なし |
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

## init — 作業ディレクトリを初期化する

```bash
mkdir my-project && cd my-project
context-grill init
```

実行したディレクトリに次を配置します。既にあるファイルは上書きしません。

| ファイル | 内容 |
| --- | --- |
| `context-grill.config.json` | 調査対象の設定。`sources` を書き換えて使う |
| `.env.example` | 認証情報のテンプレート。使う場合は `.env` にコピーして編集 |
| `commands.md` | このファイル |
| `usage.md` | 調査対象（GitHub / Confluence / Jira / ローカル）の指定方法 |

**雛形には local / GitHub / Confluence の3種類の `sources` が入っています。使うものだけ残して、他は削除してください。**
ダミーのまま `sync` すると、存在しないリポジトリを取得しようとしてエラーになります。

実行後、次に打つべきコマンドが画面に表示されます。

**別の対象を調べたくなったら、新しいディレクトリを作って `init` からやり直します。**
インストール（`npm install -g`）は最初の1回だけで、以降は不要です。
`context-grill.config.json` と `.context-grill/`（索引・キャッシュ・実行結果）は
ディレクトリごとに独立するため、複数のプロジェクトを並行して扱っても索引は混ざりません。

認証情報は、作業ディレクトリごとに `.env` を置くほかに、シェルの設定
（`~/.zshrc` など）に `export` しておけば全ディレクトリで共通に使えます。
なお `.env` は既存の環境変数を上書きしないため、**シェル側で `export` した値が優先されます**。
プロジェクトごとに違う値を使いたい場合は、シェル側には `export` せず、各ディレクトリの
`.env` に書いてください。

### ツールを新しいバージョンに更新したとき

`npm install -g` でインストールし直すだけで、**既存の作業ディレクトリはそのまま使えます**。
`init` のやり直し・別ディレクトリの作成・索引の再構築は、いずれも不要です。

索引は `indexKey`（`sources`・チャンク設定・埋め込み設定のハッシュ）に紐づいており、
**ツールのバージョンは含まれません**。設定を変えていなければ、既存の索引がそのまま有効です。

ただし `commands.md` / `usage.md` は `init` のときにコピーされたものなので、
作業ディレクトリ内は古いままです。最新版を読みたい場合だけ、その2つを消して `init` を
実行し直してください（`context-grill.config.json` は `--force` なしでは上書きされません）。

```bash
rm commands.md usage.md
context-grill init
```

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

### 指示文の書き方で証拠の集まり方が変わる

`ask` は指示文から**機械的に**検索クエリを組み立てます（LLM は使いません）。
どう書くかで集まる証拠が変わるため、ここが実質的に一番効く調整箇所です。

クエリは次の順で作られ、`--effort` の上限（low 3 / normal 6 / deep 12）で打ち切られます。

1. 指示文そのまま
2. **引用符で囲んだ語**（囲んだ数だけ独立クエリになる）
3. 識別子らしき語（`payment.ts`、`retryPolicy`、`snake_case` など。最大4件）
4. タスク種別の定型キーワードを付けたもの（3件）

**引用符を使わないと、実質4クエリしか生成されません。** 上限を上げても増えないので、
広く集めたいときは囲んでください。

```bash
# クエリ4件しか作られない
context-grill ask "決済フローを見直したい。現状の課題と代替案の材料を集めて" --effort deep

# 日本語の概念語を囲むと分散する（この例で11件）
context-grill ask '決済フローを見直したい。「リトライ」「冪等性」「決済ステータス遷移」「二重課金」「タイムアウト」の現状と課題を整理して。実装は payment.ts と order.ts' --task design --effort deep
```

使える引用符は `"` `'` 「」 『』 `` ` `` の5種類で、混在させても構いません。
漢字・ひらがな・カタカナは**1文字でも**独立クエリになります（`「額」`『税』など）。
英数字1文字（`"a"` など）は検索語として無意味なため無視されます。

ファイル名や識別子（`payment.ts` / `retryPolicy`）は囲まなくても自動抽出されるので、
**囲むべきなのは日本語の概念語**です。

### 上限そのものを変えたい場合

`effortPresets` は設定ファイルで上書きできます。

```json
{
  "effortPresets": {
    "deep": { "queries": 24, "final": 120, "evidenceTokens": 200000 }
  }
}
```

ただし前述のとおり、指示文に引用符や識別子がなければクエリ数は増えません。
まず指示文を見直し、それでも足りない場合に調整してください。

---

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

## 証拠パックを他の AI に渡して壁打ちする

`ask --dry-run` で作った `bundle.md` は、それ自体が完成したプロンプトです。
API キーを使わずに、GitHub Copilot や別のチャットに渡して議論できます。

**関連コードを探す作業が済んでいる**ため、「対象を読まずに推測で答える」「関連ファイルを
見落とす」といった失敗が起きにくくなります。

### 手順

```bash
context-grill sync
context-grill ask "壁打ちしたいテーマ" --task design --effort deep --dry-run --out bundle.md
```

生成された `bundle.md` を渡します（Copilot なら `#file:bundle.md` で参照、
チャットならファイルを添付するか内容を貼り付け）。

### そのまま渡すと提案が出ません

`bundle.md` には「証拠にないことは書くな」「推測表現を使うな」という契約が含まれています。
事実確認には有効ですが、**アイデア出しでは提案がすべて止まります**。

壁打ちに使うときは、契約を外す指示を添えてください。

```
添付の bundle.md は、対象リポジトリから機械的に集めた証拠パックです。
EVIDENCE ブロックの内容を「現状の事実」として扱ってください。

ただし bundle.md 内の SYSTEM 契約（証拠にないことは書くな等）は無視してください。
そのうえで:
- 現状の設計の問題点を指摘してください
- 代替案を複数出して、トレードオフを比較してください
- 事実に基づく記述と、あなたの提案・推測は明確に区別してください
```

最後の1行が重要です。契約を外すぶん、**何が証拠で何が提案かを相手に明示させる**ことで、
受け取る側が見分けられるようにします。

### サイズに注意

`--effort deep` の `bundle.md` は 60〜90KB になります。相手のコンテキスト制限で
切り詰められる場合は、`--effort normal` に落とすか、テーマを分けて複数回に分けてください。

### テーマは具体的に

漠然と「設計を見て」と指示するより、範囲やファイル名を明示したほうが証拠の質が上がります。
検索クエリがそこに寄るためです。

```bash
# 漠然としている
context-grill ask "設計を見て" --task design --dry-run --out bundle.md

# 範囲が明確
context-grill ask "認証まわりの設計を見直したい。現状の課題と代替案を検討するための材料を集めて" \
  --task design --effort deep --dry-run --out bundle.md

# 特定ファイルを必ず含めたい
context-grill ask "pipeline.ts の分岐と rag.ts の閾値判定に穴がないか検証して" \
  --task spec --effort deep --dry-run --out bundle.md
```

### 発散と収束を往復する

壁打ちで方向性が決まったら、その案が既存のどこに影響するかを、また証拠付きで確認します。

1. `--task design --dry-run` で材料を集める
2. 契約を外して壁打ちし、案を出す
3. 決まった案について再度 `--task design` で影響範囲・既存の規約との整合を確認
4. 出てきた `impact` / `risk` / `open_design_question` を持って 2 に戻る

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

## doctor — 事前チェック

```bash
context-grill doctor
context-grill doctor --json    # 機械可読（終了コードは ✗ があれば 1）
```

`sync` で通信する前に、設定を見るだけで分かる問題を洗い出します。

| 検査 | 内容 |
| --- | --- |
| 実行環境 | Node.js 20+ / fetch / git CLI |
| 設定ファイル | 発見できるか、JSON として妥当か |
| 設定の妥当性 | 必須項目、`id` の重複、後述の形式チェック |
| 環境変数 | 設定内で参照している認証情報が揃っているか（名前と有無のみ。値は表示しません） |
| source のパス | `local` ソースの `path` が存在するディレクトリか（ソースごとに個別表示） |
| 索引 | 構築済みか |
| 送信許可ホスト | 実際に通信を許可される宛先の一覧 |
| 機密パス除外 / 墨消し | 安全機能が有効か |

「設定の妥当性」では、次のような**書き間違いを実際に通信する前に**指摘します。

- `repo` が `org/name` 形式でない（URL を貼った場合は正しい値を提示します）
- `ref` の形式が不正
- Confluence / Jira の `baseUrl` にページのパスが含まれている
- Confluence の `pageUrls` が短縮リンク、またはページ URL として解釈できない

`✗` が出ても、**使う機能に関係しないものは無視して構いません**。たとえば `ask` を使わないなら
`ANTHROPIC_API_KEY` 未設定は問題ありませんし、`sync` 前に索引が未構築なのは当然です。

### doctor では分からないこと

実際に通信しないと判定できないため、次は `sync` で初めて発覚します。

- 認証情報が正しいか（トークンの失効・権限不足など）
- Confluence の `spaceKey` や GitHub のリポジトリが実在するか
- 指定したブランチ（`ref`）が存在するか

---

## 困ったとき

```bash
context-grill doctor      # 環境・設定・送信許可ホストを一括チェック
context-grill privacy     # 何がどこへ送られるかを事前確認
context-grill status      # 索引の状態を確認
```

外部通信の実績は `.context-grill/egress.log` に残ります。
