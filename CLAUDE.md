# CLAUDE.md — grounded

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
bin/grounded.js          エントリポイント
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
- `schema/` は空ディレクトリ。`package.json` の `files` には含まれているが中身がない

## 注意点

- **`.env` は絶対にコミットしない。** `.gitignore` に入っているが、必要な変数は
  `GITHUB_TOKEN` / `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN` / `ANTHROPIC_API_KEY` と、
  いずれも実害の大きいもの。`.env.example` のみ追跡する
- `test/security.test.js` にはダミートークン（`ghp_ABCDEF…` 等）が意図的に含まれる。
  秘密情報検出のテストなので、スキャナが反応しても正常
- `.grounded/` はインデックスのキャッシュ置き場。git 管理しない

## 未確認・次にやること

- `schema/` が空。JSON Schema を置く想定だったのか、不要になったのかが不明
- 実際に GitHub / Confluence / Jira へ接続して動かした記録がない。
  `npm run doctor` で疎通確認ができる設計になっている
- 埋め込みプロバイダ（OpenAI / Voyage）を有効にした状態での動作が未検証

## 履歴

- 2026-08-06 〜 08-07 初版作成
- 2026-08-09 Cowork のセッション領域から `~/repos/grounded/` へ移設、git 管理を開始
