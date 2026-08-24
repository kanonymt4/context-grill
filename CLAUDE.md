# CLAUDE.md — context-grill

> **このファイルは公開リポジトリに含まれます。**
> 検証や調査の記録を書く際、次のものを書き込まないこと:
> - 実在する組織名・Atlassian テナント名・社内リポジトリ名・ドメイン
> - メールアドレス、トークン、認証情報（一部でも）
> - 顧客名、プロジェクトのコードネーム、社内固有の用語
>
> 会話の中で実データに触れた場合も、記録に残すときは `your-org` `acme` などの
> プレースホルダに置き換える。検証結果として重要なのは挙動であって、対象の実名ではない。


このリポジトリを開いた Claude が最初に読むファイル。作業のたびに追記・更新する。

## これは何か

GitHub / Confluence / Jira の資料を一次資料として登録し、仕様整理・バグ調査・
セキュリティ評価・静的解析・機能設計を**根拠付き**で行う CLI + MCP サーバー。

依存パッケージゼロ（Node.js 20.10+ のみ）。ディレクトリごとコピーすれば動く。

## 中核となる設計思想

**LLM を使う工程を1箇所に閉じ込め、その前後を決定的な処理で挟む。** これが全て。

| 段階 | 処理 | LLM |
|---|---|---|
| 1 | 資料取得（GitHub / Confluence / Jira） | 不使用 |
| 2 | チャンク分割（コードは行番号保持） | 不使用 |
| 3 | クエリ計画（タスク別テンプレート＋日英辞書） | 不使用 |
| 4 | ハイブリッド検索 → RRF 融合 → MMR → 予算パッキング | 不使用 |
| 5 | 証拠の解釈（構造化 JSON を強制） | **使用** |
| 6 | 機械検証 → 修復ループ → 除去 | 不使用 |

段階6の検証項目：スキーマ違反 / 存在しない証拠 ID の引用 / **逐語引用の実在照合**
（`quotes[].text` が証拠本文に literal に含まれるか）/ 証拠なしの主張 /
推測表現と高確度の組み合わせ。

違反したら理由を添えて再生成（既定2回）、それでも通らなければ本文から除去し
「棄却された主張」欄に理由付きで記録する。

**この構造を崩さないこと。** 「検証を LLM にやらせた方が賢い」「クエリ計画も LLM で」
といった変更は、モデル非依存性という設計目標そのものを壊す。
秘密情報・インジェクション・TLS 無効化などの検出も静的ルールで行っており、
これが品質の下限を保証している。

## 構成

```
bin/context-grill.js          エントリポイント
src/cli.js               CLI
src/mcp/server.js        MCP サーバー
src/connectors/          github.js / jira.js / confluence.js / local.js / base.js
src/index/               ingest, chunk, embed, tokenize, search, store, pack, glossary
src/llm/                 provider, pipeline, jsonschema
src/analysis/            static.js, rules.js（LLM 不使用の静的検出）
src/verify/gate.js       段階6の検証ゲート
src/report/render.js     出力整形
src/util/                redact, sensitive, egress, urls, html, tokens, log, misc
test/                    unit / e2e / security
```

## 現状

- **テスト48件すべて成功**（2026-08-24 に `npm test` で確認、Node v20）
- 依存パッケージゼロ。`npm install` 不要
- CI は GitHub Actions で 3 OS（ubuntu / macOS / windows）× 3 Node（20.10 / 22 / 24）の 9 ジョブ
  （`.github/workflows/test.yml`）。依存パッケージがないため `npm install` ステップ自体が存在しない。
  テストに加えて `--help` の起動確認と `init` の生成物確認まで行う
- ~~`schema/` は空ディレクトリ~~ 2026-08-10 削除済み（経緯不明のまま package.json の files から除去。理由は下記）

## 注意点

- **`.env` は絶対にコミットしない。** `.gitignore` に入っているが、必要な変数は
  `GITHUB_TOKEN` / `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN` / `ANTHROPIC_API_KEY` と、
  いずれも実害の大きいもの。`.env.example` のみ追跡する
- `test/security.test.js` にはダミートークン（`ghp_ABCDEF…` 等）が意図的に含まれる。
  秘密情報検出のテストなので、スキャナが反応しても正常
- `.context-grill/` はインデックスのキャッシュ置き場。git 管理しない

## 開発フロー / ブランチ戦略（2026-08-22 決定）

**GitHub Flow + タグリリース。** git-flow は採らない（実質1人開発で develop に滞留する
変更がなく、管理コストだけが残るため）。

- `main` は常にリリース可能な状態を保つ。作業は `main` から短命ブランチを切る
- ブランチ名は `feat/` `fix/` `docs/` `chore/` + 内容（例: `fix/bool-flags-parsing`）
- コミットは Conventional Commits。本文は「なぜ壊れていたか」と「何を変えたか」を分けて書く
- PR は1人でも立てる（差分を俯瞰する場になる）。**Squash merge** で `main` へ入れ、
  `main` の履歴を「1テーマ＝1コミット」に保つ。`git log v0.1.0..v0.2.0 --oneline` が
  そのまま配布先向けの変更点一覧になる
- リリースは `npm version <patch|minor>` → `git push --follow-tags` → `npm pack`。
  0.x の間は「設定スキーマ・CLI 互換を壊す変更＝minor / それ以外＝patch」
- `release/x.y` ブランチは**必要になるまで作らない**。配布先が複数バージョンに分かれ、
  旧系統へのバックポートが必要になった時点で初めてタグから切る

### main の保護はサーバ側ではなくローカルで行っている

GitHub のルールセットは**無料プラン × プライベートリポジトリでは適用されない**。
UI 上は Active に見えるが force push も削除も素通りする。公式ドキュメントは Pro なら
利用可と書いているが、実際には Pro でも Team への移行を促す警告が出るという報告があり、
記述と挙動が食い違っている（課金しても解決する保証がない）。

代替として `.githooks/pre-push` を置き、`main` の削除と non-fast-forward push を
クライアント側で拒否している。意図的に破るときは `git push --no-verify`。

- **`git config core.hooksPath .githooks` は `.git/config` に入るためコミットされない。**
  別マシンで clone したら再実行が必要
- リモートの `main` がローカルに無いと祖先判定ができないため、その場合は通過させず
  `git fetch` を促して止める（判定不能を「安全」と誤認しないこと）
- public 化すればルールセットは無料で有効になる。その後も hook は残してよい
  （サーバに弾かれる前にローカルで止まるので往復が減る）

## コネクタ拡張の調査（2026-08-19 / 実装はまだ）

コネクタはプラガブル。`src/connectors/index.js` の `CONNECTORS` に1行足し、
`makeDoc()` で正規化した `{ docs, state }` を返す関数を書くだけで対象を増やせる
（Jira は 49 行、local は 45 行）。索引・検索・証拠パック・検証はすべて共通処理。

| 対象 | 実装難易度 | 索引化との相性 | 備考 |
| --- | --- | --- | --- |
| GitLab / Bitbucket | 低 | 良 | github.js の構造をほぼ流用できる |
| **Google Drive / Docs** | 中 | 良 | 第一候補 |
| Notion | 中 | 良 | ブロック構造の平坦化が必要 |
| **Slack** | 低（実装）/ 高（運用） | **悪** | レート制限が致命的 |
| SharePoint / Teams | 中 | 良 | Microsoft Graph API |
| ローカル PDF | — | — | テキスト抽出に依存パッケージが必要。ゼロ依存方針と衝突 |

### Slack: 実質的に困難

2025-05-29 以降、Slack Marketplace 未承認アプリは `conversations.history` /
`conversations.replies` が **1分1リクエスト・1回15件**に制限された。
2026-03-03 に既存インストールにも適用済み（従来は毎分50リクエスト・100件以上）。

- 1000 件の取り込みに単純計算で **67 分**かかり、「全件を索引化する」思想と噛み合わない
- `limit=100` を指定しても黙って 15 件に切り詰められ、エラーも警告も出ないため気づきにくい

回避策:
- **社内向けカスタムアプリ（internal customer-built app）は対象外**。配布先が自分の
  ワークスペース用にアプリを作る前提なら従来の制限のまま使える
- `search.messages` は制限対象外だが、検索APIなので全件取得には向かない

実装するなら「社内アプリ限定」と明記し、`limit` を小さくする前提になる。
投資に見合わない可能性が高い。

### Google Drive / Docs: 想定より現実的

認証方式は2つ。

- **OAuth ユーザー認証** — 個人向け。ブラウザ同意フローが必要で CLI とは相性が悪い
- **サービスアカウント + ドメイン全体の委任** — 企業向け。管理コンソールで
  クライアントIDとスコープ（`drive.readonly`）を登録すれば同意なしにアクセスできる

後者なら**依存パッケージなしで実装可能**。JSON キーから RS256 署名付き JWT を作って
トークンと交換するだけで、Node の `crypto` で完結する。
取得も `files.export` で Google Docs をプレーンテキストに変換でき、
Confluence の HTML 変換より簡単。

注意点:
- 設定に Google Workspace のスーパー管理者権限が必要（情シスへの依頼が前提）
- ドメイン全体の委任はなりすまし悪用が指摘される強力な権限。`drive.readonly` に絞る運用が必須

### MCP 経由での取り込みは筋が悪い

公式 MCP サーバーがある対象でも、MCP を介して索引化するのは避けるべき。

- MCP はモデルが対話的に呼ぶ前提で、全件取得・ページネーション・差分同期の制御が効かない
- 応答が呼び出しごとに変わりうるため、`indexKey` による決定性・再現性が担保できない

公式 API を直接叩くコネクタを書くほうが設計思想に合う。

---

## 未確認・次にやること

- ~~`schema/` が空~~ 2026-08-10 解消。ITEM_SCHEMA/envelopeSchema (src/tasks/index.js) は「LLM回答の構造契約」であり対象プロジェクト非依存（itemTypes も spec/debug/security/techdebt/design の固定5種）。外部化するとカスタマイズ可能に見えて evidence/quotes の強制が緩められるリスクがあるため、inline のままが妥当と判断し schema/ を削除、package.json の files からも除去
- ~~実際に GitHub / Confluence / Jira へ接続して動かした記録がない~~ 2026-08-10 GitHub のみ検証済み（private repo kanonymt4/context-grill を対象に mode:clone で実クローン成功、42ドキュメント/130チャンク、パーマリンク生成も正常）。`GITHUB_TOKEN` を用意しなくても `credential.helper=osxkeychain` があれば通ることを確認 （コードが独自 Authorization ヘッダを付けるのはトークンがある場合のみで、無い場合は素の git にフォールバックするため）。Confluence / Jira は未検証のまま
- ~~埋め込みプロバイダを有効にした状態での動作が未検証~~ 2026-08-10 検証済み。ローカル Ollama（nomic-embed-text, 768次元, openai-compat 経由）で sync→embedding API 実呼び出し→egress.log記録→ベクトル索引構築→2回目syncでキャッシュ全ヒット、を一通り確認。ただし RRF 融合の効果は一様ではなく、クエリによってはBM25単体の方が正解ファイルの順位が高いケースもあった（言い換え耐性は効く場合とそうでない場合がある）。2026-08-10 OpenAI/Voyage 実APIでも検証済み。
  - OpenAI (text-embedding-3-small, dimensions:512): sync/cache reuse/検索まで完全に成功。`dimensions` 指定時に実際に返るベクトル長も一致することを確認（キャッシュ破損リスクは杞憂だった）
  - Voyage (voyage-3-lite): 単独API呼び出しは成功するが、無料枠のレート制限(3RPM/10K TPM)に対し`retry()`のバックオフ(最大5秒程度)が短すぎ、実際の`sync`では埋め込み取得が継続的に失敗。ただし例外を握りつぶさずBM25のみへグレースフルデグレードする設計は正しく機能した（src/index/ingest.js）
  - ~~**要修正候補**: `embed.js`の`embedQuery()`が`embedChunks()`と同じ経路を通るため、Voyageのクエリでも`input_type:"document"`が固定送信される。実測で正解/無関係文書の分離度が本来の`query`指定時0.418 → 現状のbug挙動0.294と、約30%低下することを確認~~ 2026-08-21 修正
  - ~~**要修正候補**: Voyage分岐だけ`data[].index`でソートしていない（openai/openai-compatはソートあり）。レスポンス順を無条件に信頼している~~ 2026-08-21 修正
  - ~~**要修正候補**: 埋め込み取得が失敗すると`EmbedCache.close()`未到達のため、途中まで成功した分も含めて次回`sync`時にゼロからやり直しになる（部分キャッシュが永続化されない）~~ 2026-08-21 修正
- **未対応（Voyage 実運用の残課題）**: `embedChunks` のリトライは `attempts:4` / `baseMs:600` が固定で、最大待機は約 4.2 秒。Voyage 無料枠（3RPM）のような分単位のレート制限には届かないため、`sync` の失敗自体は解消していない。設定可能にするかはコストと相談
- ~~**未対応（Windows CI の残件）**: `windows-latest` の一部 Node 版で、`test/security.test.js` の
  「allowLlmUpload=false なら ask は送信前にブロックされる」の後始末が `ENOTEMPTY` で失敗する~~
  **2026-08-22 修正。切り分け手順の (2)、つまりプロダクトコードの fd リークだった。**
  `rm` に `maxRetries` を付けて黙らせなくて正解だった件（詳細は履歴）。
- ~~**未対応（MCP サーバーの二重オープン）**~~ 2026-08-22 修正（詳細は履歴）。

## 履歴

- 2026-08-06 〜 08-07 初版作成
- 2026-08-09 Cowork のセッション領域から `~/repos/context-grill/` へ移設、git 管理を開始
- 2026-08-10 埋め込みプロバイダ（openai-compat, ローカル Ollama）の動作検証を実施、上記の通り確認。副産物として `.gitignore` に改名前の `.grounded/` が残っていたのを `.context-grill/` に修正（実害はなし。ワークスペース内側の `.context-grill/.gitignore` の `*` で二重に保護されていた）。加えて schema/ を削除し package.json の files からも除去（理由は上記）

- 2026-08-10 GitHub 実接続を検証（private repo 自身を対象、mode:clone、42ドキュメント）。GITHUB_TOKEN 無しで osxkeychain 経由の認証だけで通ることを確認
- 2026-08-10 OpenAI/Voyage 実APIでの埋め込み検証を実施。OpenAIは完全成功。Voyageは無料枠のレート制限で`sync`は失敗するがBM25へのフォールバックは正常動作。input_type固定・index未ソート・部分キャッシュ非永続化の3点を修正候補として記録。（作業中、APIキーが誤ってファイル名や出力に露出する事故が2回発生、都度キーを失効・再発行して対応）
- 2026-08-10 local vs GitHub ソースの比較整理（認証コスト・鮮度・証拠の耐久性・LLMトークン消費量の4軸）。
  **LLMトークン消費量は差がないことを確認** — `isIndexable`/`isSensitiveDir` によるフィルタリングは
  `src/connectors/base.js` / `src/util/sensitive.js` の共通ロジックを両コネクタが参照しており、
  同一内容であればチャンク数・埋め込み対象・LLMへの投入トークン数は理論上同一になる
  （差が出るとすれば「未コミットの変更で内容そのものが違う」場合のみで、取得経路自体は影響しない）。
  ついでに GITHUB_TOKEN の「コスト」も整理: `mode: "clone"`（既定）は git プロトコルのみで
  REST API を一切呼ばないためレート制限に無関係。`mode: "api"` はファイル1つにつき1 API 呼び出しが
  発生し、GitHub の制限（未認証60/時・認証済み5,000/時）に直接影響するため大規模リポでは非推奨
  （コード内コメントにも明記あり）。issues/pulls 取り込みも同じ REST エンドポイントを使う。
- 2026-08-19 配布先での実運用フィードバックを反映（baseUrl のページURL誤指定・pageUrls の文字列指定・includeDescendants 未指定・コマンド名前のフラグ・漢字1文字クエリを修正）。ask の指示文の書き方を実測値つきでドキュメント化。README に他ツールとの違いと向き不向きを追加。setup.sh / setup.ps1 を削除し初期設定を npm install -g → init の1通りに統一。コネクタ拡張（Slack / Google Drive ほか）を調査（上記）
- 2026-08-21 埋め込み周りの要修正候補 3 件を修正（`src/index/embed.js`）。
  1. `embedQuery()` に `inputType: 'query'` を渡すようにし、Voyage のクエリ側が `document` で送られないようにした
  2. レスポンスの並べ直しを全プロバイダ共通にし、入力数と応答数の不一致も例外にした
  3. バッチループを `try/finally` で囲い、途中失敗でも `EmbedCache.close()` が必ず走るようにした（部分キャッシュの永続化と fd リーク防止）
  合わせて、リクエスト組み立て（`buildEmbeddingRequest`）とレスポンス解釈（`parseEmbeddingResponse`）を
  純関数として分離・export し、ネットワークなしで検証できるようにした。
  テスト 3 件追加（計 40 件、全件成功）。うち 1 件は `127.0.0.1` に立てたダミーサーバへ openai-compat で
  実際に接続し、「1 バッチ目成功 → 中断 → 再実行で 2 件キャッシュヒット」を検証する（外部 API 不要）。
- 2026-08-21 上記の受けとして、ドキュメントとコードコメントの齟齬を全件確認。記述の矛盾はなかったが（件数だけ更新）、
  その過程でコード側の穴を 2 件見つけて修正した。
  1. **埋め込みキャッシュのキーに provider が入っていなかった**。`config.js` の `indexKey` は provider を含むのに
     `embed.js` は `model|dimensions|chunk.hash` だけで、同じ model 名・次元数で openai と openai-compat を
     切り替えると別サーバのベクトルを流用してしまっていた。`embedCacheKey()` / `embedCacheNamespace()` に切り出し、
     キャッシュディレクトリ名も `<provider>-<model>-<dims>` にした。
     **既存の `.context-grill/cache/embed/<model>-<dims>/` は参照されなくなるため、初回の sync だけ再埋め込みが発生する**（旧ディレクトリは手動削除でよい）。
  2. **返ってきたベクトルの長さを誰も検証していなかった**。`EmbedCache` も `store.js` の `writeVectors()` も
     `dims` 固定ストライドで読み書きするので、API が `dimensions` と違う長さを返すとエラーも警告もなく
     vectors.bin がずれる。`parseEmbeddingResponse()` で noRetry 例外にし、`writeVectors()` にも最終ゲートを置いた。
     `openai-compat`（Ollama 等）は API 側に次元数を指定できないため、既定の 512 のまま nomic-embed-text（768）を
     使うとこれを踏む。README 7 章にも記載。
  テスト 2 件追加（計 42 件、全件成功）。
- 2026-08-22 ブランチ戦略を GitHub Flow + タグリリースに決定し、上記の通り記録。あわせて
  `.githooks/pre-push` を追加し（`main` の削除と履歴書き換えを拒否）、`core.hooksPath` を
  `.githooks` に設定した。hook に直接 stdin を流す形で4パターン（削除 / 通常の fast-forward /
  non-fast-forward / 対象外ブランチ）の終了コードを確認済み。
  GitHub のルールセットが無料プラン × プライベートリポジトリでは適用されないと判明したため、
  その代替という位置づけ（詳細は「開発フロー / ブランチ戦略」）。
  副産物として次の2点を確認した。`.gitignore` は既に必要十分で追加不要（`.env` `*.tgz`
  `.context-grill/` `node_modules/` `*.log` `.DS_Store` を網羅）。`.env` は git 履歴に一度も
  入っていない（`git log --all -- .env` が空）。後者は public 化の前提条件が1つ満たされていることを意味する。
  この時点でテストは 42 件全成功（ローカル、Node v20）。
- 2026-08-22 **`IndexStore` の fd リークを修正**。上記の Windows `ENOTEMPTY` の原因で、
  切り分け手順の (2)、つまりテスト側ではなくプロダクトコードの欠陥だった。

  **なぜ壊れていたか**: `runTask` は冒頭で `IndexStore.open()` しながら、`store.close()` を
  成功パス 2 箇所（dry-run の return と通常の return）にしか置いていなかった。
  `allowLlmUpload=false` / トークン上限超過の throw、`provider.complete()` や `verify()` の
  任意の失敗で `docs.txt` の fd が漏れる。POSIX は開いているファイルでも unlink できるため
  症状が出ず、Windows の rmdir だけが失敗していた。Node 22 / 24 で通っていたのは直っていたのではなく、
  `fsp.rm` の内部リトライがたまたま間に合っていただけと見られる。

  **CI だけの問題ではなかった**のが重要。`src/mcp/server.js` は常駐プロセスで、
  `context_grill_run_task` が失敗するたびに fd が 1 つずつ累積し、いずれ EMFILE に至る。
  しかも `allowLlmUpload=false` は設定で固定される方針なので、その配布先では
  毎回確実に失敗し、毎回確実に漏れる。フレークではなく決定的な累積。

  **何を変えたか**:
  1. `runTask` を薄いラッパに分け、本体を `runTaskWithStore()` に切り出して `try/finally` で
     `store.close()` を保証した（180 行を字下げし直さないため。差分が読める）。
     タスク名の検証は open の前に置き、未知タスク時のエラーメッセージを変えていない
  2. `src/cli.js` の `cmdStatus` / `cmdSearch` も同じ形だったので `try/finally` にした
     （短命プロセスなので実害は小さいが同じバグの種類）
  3. `IndexStore.openHandles`（静的カウンタ）を追加し、fd の open/close を `_openFd()` /
     `_closeFd()` に集約した。**close() 後に 0 に戻ること**を不変条件として表明できる

  テスト 1 件追加（計 43 件、全件成功）。Windows の ENOTEMPTY は OS 依存の症状なので
  それ自体はテストにできない。代わりに `openHandles` が元に戻ることを全 OS で検査する。
  証拠が 0 件だと fd がそもそも開かずテストが空転するため、先に dry-run を走らせて
  `pack.items.length > 0` を前提確認している。
  **このテストが本当にバグを捕まえることを、`pipeline.js` だけ修正前に戻して実測確認済み**
  （期待どおり `not ok 19` で失敗した）。
- 2026-08-22 **MCP サーバーの二重オープンと、sync の競合を修正**。

  `context_grill_run_task` だけが `runTask()` 経由で自前の `IndexStore` を開いていた。
  `pipeline.js` から `runTaskWithStore(store, config, opts)` を公開し、server 側は
  キャッシュ済みストアを渡す。**ストアの所有権は呼び出し側にあり、`runTaskWithStore` は
  `close()` を呼ばない。** タスク名の検証は `resolveTask()` に切り出して共有し、
  索引を開く前に検証する順序を維持している。

  **付随する競合を先に潰した。** `handle(msg)` は await されておらずツール呼び出しは並行し得るのに、
  `context_grill_sync` は索引再構築後にストアを閉じていた（`search` / `evidence_pack` にとっては
  既存のバグ。run_task は独立ストアだったため偶然守られていた）。今回の変更は
  run_task を共有ストア側に移すため、先に直さないと最長の処理を競合にさらすことになる。

  **壊れ方を一度誤って記録したので正しい形を残す。** 「読み取り中の fd が閉じられて
  エラーになる」のではない。`textOf` は `_fd` が null なら黙って開き直すし、JS は単一
  スレッドで null チェックと `readSync` の間に await が無いので EBADF にはならない。
  実際の被害はもっと悪い。`docs.txt` は `docs.txt.tmp` から rename で置き換えられるため
  （store.js 30 / 54 行）、close 後の開き直しは**新しいファイル**を指す一方、`this.meta` の
  オフセットは**古いまま**になる。結果、エラーも出さずに見当違いのバイト列を証拠として返す。
  参照カウントで fd を開いたまま保てば、POSIX では rename されても古い inode を参照し続ける。
  （Windows で開いているファイルへの rename がどう振る舞うかは**未検証**）

  実装は `withStore(fn)` （参照を確保して実行）と `invalidateStore()` （使用中なら閉じずに
  切り離し、最後の利用者に閉じるのを委ねる）の 2 つ。ディスパッチ側で包む形にし、
  ケース本体の字下げは変えていない。`context_grill_status` は対象外にした。`stats()` は
  `this.meta` / `this.manifest` しか見ず fd を使わない上に、包むと索引未作成時に
  `IndexStore.open()` が先に throw して案内の分岐が壊れるため。

  > **この段落の実装は 2026-08-24 に置き換え済み。** `withStore(fn)` と手動 allowlist
  > （`STORE_TOOLS`）は削除され、`runRequest(fn)` に一本化された。`context_grill_status` の
  > 特例扱いも不要になっている。現在の形は下の 2026-08-24 のエントリを参照。

  テスト 1 件追加（計 44 件）。**最初に書いたテストは無効だった。** `close()` は `_fd` を null に
  戻すだけで次の読み取りが開き直すため、「使えるか」や `openHandles` では所有権違反を
  検知できない。`IndexStore.openCount`（**減らない**累計オープン回数）を追加し、
  呼び出し前後で増えないことを表明する形に作り直した。

  **実験の前提を検証せずに結論を出しかけた。** 最初の注入実験は `python3` のヒアドキュメントが
  実行されておらず、そもそも注入が起きていなかったのに「遅延オープンのせいで検知不能」と
  誤った結論を出しかけた。**注入後に実際の差分と構文チェックを確認すること。**
  `sed` で確実に注入し直したところ、テストは期待どおり `not ok 20` で失敗した。

- 2026-08-24 **MCP サーバーのレビュー指摘 3 件を検証し、修正**。

  外部レビューで挙がった 3 件を実コードで確認し、いずれも妥当と判断した上で対応した。
  **ただし finding 1 の原因の帰属は誤っていた。** レビューは「`withStore()` ラップが
  MCP 側だけ順序を壊した」としていたが、`withStore` を外しても直らない。
  `callTool` の `context_grill_run_task` ケース自体が `await getStore()` を
  `runTaskWithStore()` より先に呼んでおり、順序の崩れは共有ストア方式にした時点で
  入っていた。**レビューの指摘が正しくても、原因の帰属まで正しいとは限らない。**

  **何を変えたか**:
  1. `resolveTask()` を `pipeline.js` から export し、ディスパッチ側の `preflight(name, args)`
     でストア取得より前に走らせる。CLI 側 `runTask()` の「タスク名検証 → 索引オープン」の
     順序と揃った。`context_grill_evidence_pack` も `TASKS[taskId]` 直引きで
     `label` の TypeError になっていたので同じ経路に載せた
  2. `getStore()` の check-then-act を解消。`if (!store) store = await open()` は null チェックと
     代入の間に await が挟まるため、`handle(msg)` が await されない以上、同一 stdin チャンクの
     複数リクエストが双方 `store === null` を見て open() を二重に走らせる。「開く処理そのもの」
     （in-flight promise）を共有する形に変え、判定と代入の間に await 境界を作らないようにした。
     致命的破損はなく被害は索引ファイルの無駄な再読み込みだけだが、テストで再現できる
  3. 手動 allowlist `STORE_TOOLS` を廃止し、`runRequest(fn)` に一本化。参照カウントの確保を
     リクエストスコープの `getStore` の内側に移したので、**新しいツールを足しても登録漏れが
     起き得ない**（呼んだ時点で必ず参照が確保される）。取得が遅延になったことで
     `context_grill_status` の特例扱いも消えた

  **既知の隙（未対応）**: `openStore()` の実行中に `sync` が入ると、`store = null` の後に
  in-flight の open() が解決して古いストアが `store` に代入され得る。fd は rename 前の
  inode を指し続けるので見当違いのバイト列は返らず、実害は「一世代古い証拠を返し得る」
  までに留まる。直すなら索引に世代番号を持たせる。`invalidateStore()` の doc コメントにも
  同じ内容を残した。

  テスト 4 件追加（計 48 件）。MCP サーバーを子プロセスで起動し stdio に JSON-RPC を流す
  ハーネスを `test/mcp.test.js` に新設した。並行性の再現には **2 リクエストを 1 回の
  `stdin.write` で送る**必要がある（`handle(msg)` が await されない条件そのもの）。
  `IndexStore.open()` の呼び出し回数は既存の `openCount` / `openHandles` では数えられない
  ことに注意。**あれは fd の開閉カウンタで、`open()` 自体は manifest / docs.meta / df / lens の
  JSON を読むだけで fd を使わない。** そのため `IndexStore.open` を包んで数える probe
  スクリプトを一時生成して起動している。

  **finding 3 だけは実行時テストにできなかった。** 失敗モードが「将来ツールを追加したとき
  登録を忘れる」であり、現時点で登録漏れしているツールが存在しないため。
  （`context_grill_status` は `getStore()` 直呼びだが、取得と `stats()` の間に await が無く
  `stats()` は fd も触らないので実際には壊れない。）代わりに「登録漏れが起こり得ない構造で
  あること」をソース文字列で表明する **lint 相当の構造ガード** にした。**この 4 件目が落ちた
  ときは、まず実装ではなくテストの正規表現を疑うこと。**

  **CI が windows-latest の 3 ジョブだけで落ちた。原因はテストの後始末で、プロダクトコードは
  無実だった。** 47 pass / 1 fail、落ちたのは追加した並行性テストのみ。しかもエラーは
  「実際: 2 回」ではなく **「実際: null 回」** — 二重オープンが起きたのではなく、計測値が
  取れていなかった。probe の集計を `process.on('SIGTERM')` で出していたが、**Windows には
  SIGTERM が無く**、`child.kill('SIGTERM')` はハンドラを走らせずにプロセスを強制終了する。

  代案として「終了用の番兵行を stdin で送る」を試したが**これも駄目だった**。
  **stdin は最初の 'data' リスナが付いた時点で流れ始める**ため、probe 側でリスナを付けると
  server が自分のリスナを付ける前に最初のチャンクを取りこぼし、応答が 1 件も返らなくなる。

  最終形は「`IndexStore.open()` のたびに stderr へ印を出し、親が印の数を数える」。出力側だけで
  完結するので OS にもリスナ登録のタイミングにも依存しない。停止は `SIGKILL`（ハンドラを
  介さないので Windows でも同じ）。**前回の PR でも Windows の fd 挙動で踏んでおり、
  OS 依存の後始末で二度同じ踏み方をした。子プロセスの後始末はシグナルに頼らないこと。**

  この修正後も、`getStore()` を check-then-act に戻す注入で「実際: 2 回」で落ちることを
  再確認済み（印を数える方式が常に 1 を返すだけの空テストになっていないことの確認）。
