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

- **テスト42件すべて成功**（2026-08-21 に `node --test test/` で確認、Node v20.15.1）
- 依存パッケージゼロ。`npm install` 不要
- ~~`schema/` は空ディレクトリ~~ 2026-08-10 削除済み（経緯不明のまま package.json の files から除去。理由は下記）

## 注意点

- **`.env` は絶対にコミットしない。** `.gitignore` に入っているが、必要な変数は
  `GITHUB_TOKEN` / `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN` / `ANTHROPIC_API_KEY` と、
  いずれも実害の大きいもの。`.env.example` のみ追跡する
- `test/security.test.js` にはダミートークン（`ghp_ABCDEF…` 等）が意図的に含まれる。
  秘密情報検出のテストなので、スキャナが反応しても正常
- `.context-grill/` はインデックスのキャッシュ置き場。git 管理しない

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
