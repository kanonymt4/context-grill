# CLAUDE.md — context-grill

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

- **テスト37件すべて成功**（2026-08-09 に `node --test test/` で確認、Node v20.15.1）
- 依存パッケージゼロ。`npm install` 不要
- ~~`schema/` は空ディレクトリ~~ 2026-08-10 削除済み（経緯不明のまま package.json の files から除去。理由は下記）

## 注意点

- **`.env` は絶対にコミットしない。** `.gitignore` に入っているが、必要な変数は
  `GITHUB_TOKEN` / `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN` / `ANTHROPIC_API_KEY` と、
  いずれも実害の大きいもの。`.env.example` のみ追跡する
- `test/security.test.js` にはダミートークン（`ghp_ABCDEF…` 等）が意図的に含まれる。
  秘密情報検出のテストなので、スキャナが反応しても正常
- `.context-grill/` はインデックスのキャッシュ置き場。git 管理しない

## 未確認・次にやること

- ~~`schema/` が空~~ 2026-08-10 解消。ITEM_SCHEMA/envelopeSchema (src/tasks/index.js) は「LLM回答の構造契約」であり対象プロジェクト非依存（itemTypes も spec/debug/security/techdebt/design の固定5種）。外部化するとカスタマイズ可能に見えて evidence/quotes の強制が緩められるリスクがあるため、inline のままが妥当と判断し schema/ を削除、package.json の files からも除去
- ~~実際に GitHub / Confluence / Jira へ接続して動かした記録がない~~ 2026-08-10 GitHub のみ検証済み（private repo kanonymt4/context-grill を対象に mode:clone で実クローン成功、42ドキュメント/130チャンク、パーマリンク生成も正常）。`GITHUB_TOKEN` を用意しなくても `credential.helper=osxkeychain` があれば通ることを確認 （コードが独自 Authorization ヘッダを付けるのはトークンがある場合のみで、無い場合は素の git にフォールバックするため）。Confluence / Jira は未検証のまま
- ~~埋め込みプロバイダを有効にした状態での動作が未検証~~ 2026-08-10 検証済み。ローカル Ollama（nomic-embed-text, 768次元, openai-compat 経由）で sync→embedding API 実呼び出し→egress.log記録→ベクトル索引構築→2回目syncでキャッシュ全ヒット、を一通り確認。ただし RRF 融合の効果は一様ではなく、クエリによってはBM25単体の方が正解ファイルの順位が高いケースもあった（言い換え耐性は効く場合とそうでない場合がある）。2026-08-10 OpenAI/Voyage 実APIでも検証済み。
  - OpenAI (text-embedding-3-small, dimensions:512): sync/cache reuse/検索まで完全に成功。`dimensions` 指定時に実際に返るベクトル長も一致することを確認（キャッシュ破損リスクは杞憂だった）
  - Voyage (voyage-3-lite): 単独API呼び出しは成功するが、無料枠のレート制限(3RPM/10K TPM)に対し`retry()`のバックオフ(最大5秒程度)が短すぎ、実際の`sync`では埋め込み取得が継続的に失敗。ただし例外を握りつぶさずBM25のみへグレースフルデグレードする設計は正しく機能した（src/index/ingest.js）
  - **要修正候補**: `embed.js`の`embedQuery()`が`embedChunks()`と同じ経路を通るため、Voyageのクエリでも`input_type:"document"`が固定送信される。実測で正解/無関係文書の分離度が本来の`query`指定時0.418 → 現状のbug挙動0.294と、約30%低下することを確認
  - **要修正候補**: Voyage分岐だけ`data[].index`でソートしていない（openai/openai-compatはソートあり）。レスポンス順を無条件に信頼している
  - **要修正候補**: 埋め込み取得が失敗すると`EmbedCache.close()`未到達のため、途中まで成功した分も含めて次回`sync`時にゼロからやり直しになる（部分キャッシュが永続化されない）

## 履歴

- 2026-08-06 〜 08-07 初版作成
- 2026-08-09 Cowork のセッション領域から `~/repos/context-grill/` へ移設、git 管理を開始
- 2026-08-10 埋め込みプロバイダ（openai-compat, ローカル Ollama）の動作検証を実施、上記の通り確認。副産物として `.gitignore` に改名前の `.grounded/` が残っていたのを `.context-grill/` に修正（実害はなし。ワークスペース内側の `.context-grill/.gitignore` の `*` で二重に保護されていた）。加えて schema/ を削除し package.json の files からも除去（理由は上記）

- 2026-08-10 GitHub 実接続を検証（private repo 自身を対象、mode:clone、42ドキュメント）。GITHUB_TOKEN 無しで osxkeychain 経由の認証だけで通ることを確認
- 2026-08-10 OpenAI/Voyage 実APIでの埋め込み検証を実施。OpenAIは完全成功。Voyageは無料枠のレート制限で`sync`は失敗するがBM25へのフォールバックは正常動作。input_type固定・index未ソート・部分キャッシュ非永続化の3点を修正候補として記録。（作業中、APIキーが誤ってファイル名や出力に露出する事故が2回発生、都度キーを失効・再発行して対応）