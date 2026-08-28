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

<!-- 書式:
     UNVERIFIED-NNN で採番する。解消しても項目を消さず status: CLOSED にして残す
     （誤っていた前提の記録そのものが再発防止の材料になるため）。
     5 欄すべて必須。CLOSED はさらに「解消」欄が要る。
     検査: node scripts/check-unverified.mjs

     「外れた場合に無効になるもの」が この書式の要。ここを埋められないなら、
     その前提はまだ理解できていない。実装に進む前に埋めること。 -->

### UNVERIFIED-001 — `schema/` が空
- status: CLOSED
- 前提: LLM 回答の構造契約は外部ファイルに切り出したほうがよい
- 検証方法: `src/tasks/index.js` の ITEM_SCHEMA / envelopeSchema の用途を確認
- 影響ファイル: src/tasks/index.js, package.json
- 外れた場合に無効になるもの: `schema/` を配布物に含める判断
- 解消: 2026-08-10 対象プロジェクト非依存かつ evidence/quotes の強制が緩むリスクがあるため inline のままが妥当と判断。`schema/` を削除し package.json の files からも除去

### UNVERIFIED-002 — 実際に GitHub / Confluence / Jira へ接続して動かした記録がない
- status: CLOSED
- 前提: コネクタは実接続でも動く
- 検証方法: private repo 自身を対象に mode:clone で実クローン
- 影響ファイル: src/connectors/confluence.js, src/connectors/jira.js
- 外れた場合に無効になるもの: 「一次資料を取り込む」という製品前提そのもの
- 解消: 2026-08-10 GitHub のみ検証済み（42 ドキュメント / 130 チャンク、パーマリンク生成も正常。`GITHUB_TOKEN` 無しでも `credential.helper=osxkeychain` があれば通る）。Confluence / Jira は UNVERIFIED-019 へ引き継ぐ

### UNVERIFIED-003 — 埋め込みプロバイダを有効にした状態での動作が未検証
- status: CLOSED
- 前提: 埋め込みを有効にすれば検索品質が上がる
- 検証方法: ローカル Ollama / OpenAI / Voyage の実 API で sync→検索まで通す
- 影響ファイル: src/index/embed.js
- 外れた場合に無効になるもの: ハイブリッド検索の RRF 融合を既定にする判断
- 解消: 2026-08-10 検証済み。ただし RRF の効果は一様ではなく、クエリによっては BM25 単体のほうが正解ファイルの順位が高いケースもある（言い換え耐性は効く場合とそうでない場合がある）

### UNVERIFIED-004 — `embedQuery()` が `input_type:"document"` を固定送信
- status: CLOSED
- 前提: クエリ側と文書側で同じ経路を使っても分離度は変わらない
- 検証方法: 正解／無関係文書の分離度を実測して比較
- 影響ファイル: src/index/embed.js
- 外れた場合に無効になるもの: `embedChunks()` と `embedQuery()` の経路共用
- 解消: 2026-08-21 修正。前提は誤りだった。本来の `query` 指定時 0.418 に対し bug 挙動は 0.294 で、約 30% 低下していた

### UNVERIFIED-005 — Voyage 分岐だけ `data[].index` でソートしていない
- status: CLOSED
- 前提: 埋め込み API はリクエスト順にレスポンスを返す
- 検証方法: openai / openai-compat の実装と突き合わせ
- 影響ファイル: src/index/embed.js
- 外れた場合に無効になるもの: レスポンス順を信頼するすべてのプロバイダ分岐
- 解消: 2026-08-21 修正。並べ直しを全プロバイダ共通にし、入力数と応答数の不一致も例外にした

### UNVERIFIED-006 — 埋め込み取得の失敗で `EmbedCache.close()` が未到達
- status: CLOSED
- 前提: 途中まで成功した埋め込みはキャッシュに残る
- 検証方法: `127.0.0.1` のダミーサーバで「1 バッチ目成功 → 中断 → 再実行」を再現
- 影響ファイル: src/index/embed.js
- 外れた場合に無効になるもの: 失敗時に再実行すれば安いという運用前提
- 解消: 2026-08-21 修正。バッチループを `try/finally` で囲い、部分キャッシュの永続化と fd リーク防止を両立

### UNVERIFIED-007 — `windows-latest` の一部 Node 版で後始末が `ENOTEMPTY` になる
- status: CLOSED
- 前提: テスト側の後始末の問題で、`rm` に `maxRetries` を付ければ解決する
- 検証方法: 切り分け手順 (1)(2)(3) のうち (2) プロダクトコードの fd リークを先に潰す
- 影響ファイル: src/llm/pipeline.js, src/cli.js
- 外れた場合に無効になるもの: 「CI 固有のフレーク」という被害範囲の見積もりそのもの
- 解消: 2026-08-22 修正（#2）。前提は誤りだった。`runTask` の例外パスで fd が漏れており、MCP 常駐プロセスでは `run_task` が失敗するたびに決定的に累積して EMFILE に至る経路だった。リトライで黙らせなくて正解だった

### UNVERIFIED-008 — MCP サーバーが `run_task` 経由で `IndexStore` を二重に開く
- status: CLOSED
- 前提: 二重オープンは無駄なだけで実害はない
- 検証方法: `IndexStore.openCount`（減らない累計）で所有権違反を表明する
- 影響ファイル: src/mcp/server.js, src/llm/pipeline.js
- 外れた場合に無効になるもの: `getStore()` によるストア 1 個キャッシュという設計
- 解消: 2026-08-22 修正（#4）。付随して `handle(msg)` が await されないことによる sync との競合も先に潰した

### UNVERIFIED-009 — Windows で開いているファイルへの rename の挙動
- status: CLOSED
- 前提: 参照カウントで fd を開いたまま保てば、POSIX 同様に古い inode を参照し続ける
- 検証方法: 別プロセスに `docs.txt` を握らせた状態でファイル操作を実測（scripts/platform-probe1〜5）
- 影響ファイル: src/index/store.js, src/mcp/server.js
- 外れた場合に無効になるもの: #4 の参照カウント方式そのもの（rename による publish を前提にしている）
- 解消: 2026-08-26 実測（#10）。前提は誤りだった。Windows では古い inode を参照する以前に **rename 自体が EPERM で失敗する**。4 日間この欄に上がらず履歴の括弧書きにだけ残っていたため、UNVERIFIED-015 として現実化した

### UNVERIFIED-010 — MCP: 索引オープン中に sync が入ると古いストアが居座る
- status: CLOSED
- 前提: 実害は「一世代古い証拠を返し得る」までに留まる。MCP の in-flight open との競合が必要
- 検証方法: MCP もレースも介さない再現スクリプト（開く → 作り直す → 検索）
- 影響ファイル: src/index/store.js
- 外れた場合に無効になるもの: 被害の見積もりと、修正の優先度づけ
- 解消: 2026-08-25 修正（#5）。前提は 3 項目すべて誤りだった。実害は `TypeError` で検索が落ちること、範囲は既存資料へのクエリにも及ぶこと、競合は不要でストアを保持したまま作り直せば必ず起きること

### UNVERIFIED-011 — MCP: 古いストアが `store` に居座る
- status: CLOSED
- 前提: `openStore()` が `await` 後に無条件代入しても、`invalidateStore()` が先に走れば消える
- 検証方法: `writeProbe` の `openDelayMs` で「open() 実行中に sync が入る」状況を確定的に作る
- 影響ファイル: src/mcp/server.js
- 外れた場合に無効になるもの: `invalidateStore()` による世代切り替えの正しさ
- 解消: 2026-08-25 修正（#6）。`generation` カウンタと `opening = { gen, promise }` で解決

### UNVERIFIED-012 — `open()` が検索しないコマンドでも postings を全部読む
- status: CLOSED
- 前提: スナップショット化のコストは無視できる
- 検証方法: scripts/bench-index.mjs で索引規模ごとに実測
- 影響ファイル: src/index/store.js, src/cli.js
- 外れた場合に無効になるもの: スナップショット化を全コマンド一律に適用する判断
- 解消: 2026-08-25 修正（#8）。10,541 チャンクで 68ms / 25MB。`open(dir, { postings: false })` を追加し `status` のみ適用。なお 205 チャンクからの線形外挿は 7.5 倍外した

### UNVERIFIED-013 — `embedChunks` のリトライ設定が固定
- status: OPEN
- 前提: `attempts:4` / `baseMs:600`（最大待機 約 4.2 秒）で実運用のレート制限に足りる
- 検証方法: 未実施。Voyage 無料枠（3RPM / 10K TPM）で `sync` を通す
- 影響ファイル: src/index/embed.js
- 外れた場合に無効になるもの: 分単位のレート制限を持つプロバイダのサポート表明

### UNVERIFIED-014 — `finish()` がアトミックでない
- status: CLOSED
- 前提: rename 1 回 + writeFile 6 回に分かれた窓で `open()` すると新旧が混ざる
- 検証方法: scripts/platform-probe6.mjs ほか（2026-08-26 実施）。窓は 313ms、`open()` は 156ms
- 影響ファイル: src/index/store.js
- 外れた場合に無効になるもの: 世代番号方式の publish 設計そのもの。窓の存在が前提
- 解消: 2026-08-27 #13。全ファイルを `layout()` の世代番号つき名前で書き、公開は
  `manifest.NNNN.json.tmp` → `manifest.NNNN.json` の rename 1 回だけにした（store.js:158-162）。
  `latestGen()` は `^manifest\.(\d{4})\.json$` の存在しか見ない（store.js:35-49）ため、書きかけの
  世代は読み手から見えない。窓そのものが消えた。CI 9/9 緑、ローカル 56 pass

### UNVERIFIED-015 — CLI と MCP をまたぐ Windows の EPERM
- status: CLOSED
- 前提: `docs.txt` を rename で置き換えるのをやめない限り解決しない
- 検証方法: scripts/platform-probe4.mjs（MCP 常駐下で別プロセスの CLI sync、exit code 1 を確認済み）
- 影響ファイル: src/index/store.js, src/mcp/server.js
- 外れた場合に無効になるもの: 世代番号方式を採る動機の 1 つ。プロセス境界をまたぐ通知手段があるなら別解になる
- 解消: 2026-08-27 #13。索引側の rename は `publish()` の 1 箇所だけになり、宛先が毎回まだ存在しない
  名前になった。開いているファイルを rename の宛先にする箇所が `src/index/` から消えたため、MCP が
  常駐していても別プロセスの CLI sync が EPERM を踏まない。残った Windows 接触点は unlink 側へ移り、
  UNVERIFIED-024 として起こした

### UNVERIFIED-016 — `writeVectors()` が truncate 上書き
- status: CLOSED
- 前提: `open()` 時点のスナップショットという保証が `vectors.bin` には効いていない
- 検証方法: 未実施。ストアを保持したまま作り直し、旧 meta と新ベクトルの組み合わせを再現する
- 影響ファイル: src/index/store.js
- 外れた場合に無効になるもの: 「開いたストアは作り直しの影響を受けない」という #5 の不変条件
- 解消: 2026-08-27 #13。`vectors.NNNN.bin` と世代ごとに別ファイルになり（store.js:29）、さらに
  `writeVectors()` は `manifest.NNNN.json.tmp` が無ければ throw する（store.js:374-376）。`'w'` で
  開くこと自体は変えていないが、対象が未公開の新規ファイルに限定され、公開済み世代への上書きが
  構造的に禁止された

### UNVERIFIED-017 — `finally` の解放条件がテストで直接検証されていない
- status: OPEN
- 前提: `if (opening === rec)` で、世代交代後に古い rec が解決しても新しい方を消さない
- 検証方法: 未実施。現在のテストはその解決順序を踏んでいない
- 影響ファイル: src/mcp/server.js
- 外れた場合に無効になるもの: #6 の世代ガードが守る範囲。設計案に無く実装中に足した箇所

### UNVERIFIED-018 — `invalidateStore()` の doc コメントに誤った記述が残っている
- status: CLOSED
- 前提: 誤った実害の記述（「実害は一世代古い証拠を返し得るまで」）がコメントに残っている
- 検証方法: 該当箇所の目視確認
- 影響ファイル: src/mcp/server.js
- 外れた場合に無効になるもの: なし（記述の不整合）
- 解消: 2026-08-25 #6 で訂正済み。CLAUDE.md 履歴 2026-08-24 の「こちらの訂正は未着手」が翌日には古くなっていたのに更新されず、この欄への移行時に OPEN として起こしてしまった。**記録ではなくソースを見て確認すること**

### UNVERIFIED-019 — Confluence / Jira コネクタが未検証
- status: OPEN
- 前提: GitHub と同じ経路を通るので、実接続でも同様に動く
- 検証方法: 未実施。実テナントへの接続には認証情報の用意が要る
- 影響ファイル: src/connectors/confluence.js, src/connectors/jira.js
- 外れた場合に無効になるもの: README とリポジトリ説明の「GitHub / Confluence / Jira を一次資料として」という表明

### UNVERIFIED-020 — seqlock の再試行上限が恣意的なパラメータになる
- status: CLOSED
- 前提: 読み手の再試行回数に妥当な既定値が決められる
- 検証方法: 2026-08-26 一部実施。書き手 100ms 間隔なら読み手 4,498 回成功・再試行は再構築 1 回につき 1 回程度。ただし 11.7ms 間隔では読み手が一度も成功できず（starvation）、500ms 間隔でも再試行 50 回を使い切る事例が 19 回中 1 回
- 影響ファイル: （設計判断・ファイル未定）
- 外れた場合に無効になるもの: seqlock（状態ファイル + 読み手の世代再確認）を採用する判断
- 解消: 2026-08-27 #13。seqlock を採らず、`manifest.NNNN.json` の存在を公開の印にする readdir 方式
  （`latestGen()`）にしたため、読み手の再試行という概念自体が無くなった。採らなかった根拠は上の
  検証方法の数字（11.7ms 間隔で starvation）。項目は消さずに残す —— 将来また seqlock を提案する人が
  測り直さずに済むように

### UNVERIFIED-021 — 参照カウントの説明コメントが Windows について「未検証」のまま
- status: CLOSED
- 前提: 「fd を開いたまま保てば実行中の読み取りは一貫した内容を見る」が全 OS で成立する
- 検証方法: UNVERIFIED-009 で実測済み。Windows では rename が EPERM で失敗し成立しない
- 影響ファイル: src/mcp/server.js
- 外れた場合に無効になるもの: なし（記述の不整合。次に読む人が「未検証」を見て再度測り直す、あるいは POSIX の保証を全 OS のものと誤読する）
- 解消: 2026-08-27 コメントを実測結果に差し替え。UNVERIFIED-015 への参照も入れた

### UNVERIFIED-022 — クラッシュで中断した世代の後始末
- status: OPEN
- 前提: `IndexBuilder.start()` が `(latestGen(dir) ?? 0) + 1` で世代を決め、`fs.openSync(this.L.docs, 'w')`
  で即 truncate する。クラッシュで manifest まで到達しなかった世代 N の残骸は、次回の start() が同じ N を
  選んで上書きするので害がない —— つまり「同時に 2 つの sync が走らない」ことに依存している
- 検証方法: 未実施。scripts/platform-probe6.mjs の 9 項目はクラッシュも同時実行も扱っていない
- 影響ファイル: src/index/store.js
- 外れた場合に無効になるもの: 「公開済みの世代は二度と変更しない」という不変条件。2 つの sync が同じ
  世代番号を掴むと、片方の docs を片方の meta で読むことになり、UNVERIFIED-014 の 313ms の窓と同じ
  症状が窓なしで起きる

### UNVERIFIED-023 — `writeDocsCache()` が既存名へ rename している
- status: OPEN
- 前提: `docs.jsonl.tmp` → `docs.jsonl` は既存名への rename だが、`readDocsCache()` が `fsp.readFile()`
  で一括読みして即閉じる（base.js:68-71）ため、Windows で EPERM を踏む条件——誰かが fd を保持している
  ——が成立しない
- 検証方法: 2026-08-27 に MCP の rename テストが経路を検出したのみ。この前提自体は未実測
- 影響ファイル: src/connectors/base.js
- 外れた場合に無効になるもの: 「索引側だけ世代番号方式にすれば Windows は安全」という現在の線引き。
  ストリーム読み・遅延読みへの変更や、常駐プロセスがキャッシュを保持する設計は前提を壊す

### UNVERIFIED-024 — `pruneGenerations()` の消し残しが積み上がらない
- status: OPEN
- 前提: unlink 失敗を握り潰して「次回に回す」（store.js:52-71）が成立する。つまり使用中で消せなかった
  世代は、次の sync までに保持者が閉じており、そのとき回収される
- 検証方法: 未実施。MCP を常駐させたまま Windows で sync を繰り返し、世代が何個まで残るかを測る
- 影響ファイル: src/index/store.js
- 外れた場合に無効になるもの: 1 世代 141.9MB（CLAUDE.md:484-486 実測）を前提にしたディスク使用量の
  見積もり。常駐 MCP が古い世代を握り続けると、回収は MCP の再起動時にしか起きない

### UNVERIFIED-025 — 参照カウントの説明コメントが #13 以前の publish 方式のまま
- status: OPEN
- 前提: 「`docs.txt` は `docs.txt.tmp` から rename で置き換えられる」（server.js:134-137, 192, 385-388）
  が現在の実装である
- 検証方法: 2026-08-28 に該当3箇所を目視。実際には `IndexBuilder.start()` が `docs.NNNN.txt` を
  `fs.openSync(p, 'w')` で直接開いており（store.js:99-103）、docs の rename は存在しない。索引側で
  rename するのは `manifest.NNNN.json.tmp` → `manifest.NNNN.json` の 1 箇所だけ（store.js:158-162）
- 影響ファイル: src/mcp/server.js
- 外れた場合に無効になるもの: `context_grill_sync` が `buildIndex()` の前に `invalidateStore()` を
  呼ぶ理由づけ。コメントは「Windows で rename が EPERM になるから」と書いているが、その経路は #13 で
  消えた。いま残っている理由は UNVERIFIED-010/011 の「古いストアが居座る」ほうで、コメントを信じて
  この呼び出しを消すと別のバグが戻る。UNVERIFIED-018 / 021 と同じ「記録が実装より古い」の再発

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
  （2026-08-26 実測: Windows では**開いているファイルを rename の宛先にできず EPERM** になる。
  POSIX のように古い inode を参照し続ける以前に、rename 自体が失敗する）

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

- 2026-08-25 **MCP の `openStore()` に世代番号のガードを入れた**。

  `openStore()` は `await` の後で無条件に `store = s` と代入していたため、その間に
  `invalidateStore()` が `store = null` にしても、解決した古いストアが再代入されて居座る。
  `IndexStore` のスナップショット化（同日）で例外は出なくなったが、正常な形のまま
  一世代前の索引を引き続けるので、かえって気づきにくい。

  `generation` を `invalidateStore()` で進め、`opening` を `{ gen, promise }` で持つ。
  `await` から戻った時点で世代が変わっていたら `store` に代入しない。呼び出し元は返り値を
  そのまま使い、`release()` が `s !== store` と判定して閉じる。

  設計案に無く実装中に足した点: `finally` の解放条件を `if (opening === rec)` にした。
  世代が変わって `opening` が新しい rec に差し替わった後に古い rec が解決したとき、
  新しい方を消さないため。**この順序はテストで直接検証していない。**

- 2026-08-25 **`IndexStore` を開いた時点のスナップショットとして固定**。

  **なぜ壊れていたか**: `meta`/`df`/`lens` は `open()` 時に読み切る一方、`postings` だけを
  検索時にパス指定で遅延読み込みしていた。`docs.txt` は fd 保持で rename 前の実体を
  読み続けるのに対し、`postings` は新しい実体を読む。この非対称のため、ストアを開いたまま
  索引を作り直すと `meta`（古い）と doc id（新しい）の世代がずれ、`store.meta[idx]` が
  undefined になって `search.js` が落ちる。

  **切り分け**: MCP もレースも介さない再現スクリプトで確認した。「開く → 作り直す → 検索」
  だけで再現し、新規に追加された資料と無関係なクエリでも落ちる。当初の想定（レース固有・
  静かに古い証拠を返す）は両方とも誤りだった。

  **実測**（2,178 ドキュメント / 10,541 チャンク / 91,259 語）:
  postings 合計 11.3MB、`open()` 36.6ms → 102.8ms、常駐ヒープ +25MB。
  `docs.meta.json` 7.4MB を既に全ロードしているため桁は変わらない。
  なお小規模索引（205 チャンク）からの線形外挿は **7.5 倍外した**。
  チャンクあたり実測は postings 1.07KB / ヒープ 2.4KB。

  シャードの欠損・破損は `open()` 時点で原因の分かるメッセージとともに失敗させる
  （旧 `_shard()` は遅延読み込み時に例外。新実装で `|| {}` を持たせかけたが厳密側に倒した）。
  テスト 2 件追加（計 50 件）。

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
  in-flight の open() が解決して古いストアが `store` に代入され得る。
  ~~fd は rename 前の inode を指し続けるので見当違いのバイト列は返らず、実害は
  「一世代古い証拠を返し得る」までに留まる~~ → **2026-08-25 に誤りと判明**。`docs.txt` は
  fd 保持だが `postings` はパス指定で読むため、実際は `TypeError` で落ちる。
  直すなら索引に世代番号を持たせる。`invalidateStore()` の doc コメントにも同じ内容を残した
  （こちらの訂正は未着手）。

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
- 2026-08-25 **`IndexStore.open(dir, { postings: false })` を追加**。

  **なぜ入れたか**: スナップショット化（同日の別修正）で `open()` が索引サイズに比例した
  コストを払うようになった。`status` コマンドは `store.stats()` しか使わず、`stats()` は
  `meta`/`manifest`/`dims`/`N` しか参照しない。実測（10,541 チャンク）で postings 読み込み
  だけで 68ms / 25MB を検索しないコマンドが無駄に払っていた。

  **何を変えたか**: `postings: false` のとき `_shards` を空 Map ではなく `null` にする
  （「読んでいない」ことを区別するため）。`postings()` に未ロード時のガードを追加し、
  `TypeError` ではなく原因の分かるエラーで落ちるようにした（`bm25()` は内部で `postings()`
  を呼ぶため自動的にカバーされる）。既定値は `true` なので `open(dir)` の既存呼び出しは無変更。

  `cmdStatus()` のみ `{ postings: false }` で開くよう変更。`cmdSearch()` と `runTask` 経由の
  検索系は postings を使うため対象外。

  テスト 1 件追加（計 52 件）。

- 2026-08-26 **MCP の `sync` が索引を作り直す前にストアを手放すよう修正**（#9）。`syncSources` の
  あと `buildIndex` を呼び、その**後**で `invalidateStore()` していたため、検索で開いた `docs.txt`
  の fd を握ったまま `finish()` の rename が走っていた。Windows では EPERM で落ち、リトライしても
  回復しない（publish する側が自分の握るハンドルに阻まれるため）。`invalidateStore()` を
  `buildIndex()` の前に移した。失敗時は `syncSources` だけ完走してキャッシュが更新され、索引は
  旧世代のまま残るので、「sync はエラーになるが検索は動く。ただし結果がいつまでも古い」という
  形で現れる。テストは EPERM そのものではなく「rename の時点で開いたままのストアの数」を見る
  （OS に依存せず失敗させるため）。probe 内で `IndexStore.open` / `close` をフックして生存数を
  数え、`fsp.rename` の瞬間に stderr へ出す。テスト 1 件追加（計 53 件）。

- 2026-08-26 **索引の書き込み経路をプラットフォーム横断で実測**。以降の設計判断はこの数値に基づく。

  **`finish()` の窓（17,534 チャンク）**: rename 開始から `manifest.json` 書き込み完了まで
  **313ms**。`IndexStore.open()` は **156ms**（中央値）。窓の途中で開くと、(1) rename 直後は
  JSON 群が全部旧世代なのに `docs.txt` だけ新しく、`textOf(0)` が別文書のバイト列を返す。
  (2) postings 書き込み後は doc id が meta の件数を超え、`chunkAt()` が空本文を返す。
  (3) `docs.meta.json` の後は `N` だけ旧値で、BM25 の idf がずれ、`vectorSearch` が N 行しか
  走査しない。**いずれも例外にならない**。

  **torn read**: `writeFile` は `'w'` で truncate してから書くので、**サイズに関係なく**空ファイルを
  読む窓がある（60 バイトで 8.5%、1KB で 5.1%）。512KB を超えると Node が書き込みを分割するため
  部分内容も読める。実索引の postings は 383〜763KB で、32 本中 19〜23 本が 512KB 超。
  世代の違う実ファイル 35 本を 4KB / 64KB / 512KB / 1MB の境界で接合したところ、**93 回中 70 回
  （75%）が JSON として通った**。同じ形の繰り返し構造なので閉じ括弧まで揃ってしまう。
  切り詰めただけなら 93 回中 0 回。**torn read の主要な結末は例外ではなく、混ざったデータの黙認**。

  **1 世代のディスク**: docs.txt 43.5MB / vectors.bin 68.5MB（dims=1024 を実際に書いて計測）/
  postings 32 本 16.2MB / docs.meta.json 11.9MB / df.json 1.7MB / lens.json 0.1MB = **141.9MB**。
  2 世代同時なら 283.7MB。`vectors.bin` が全体の 48%。

  **Windows のファイル操作**（別プロセスが `docs.txt` を開いた状態。macOS / Linux は全て可）:
  開いているファイルへの rename は **EPERM**。ディレクトリの rename / `rm -rf` も **EPERM**
  （`rm -rf` は中のファイルを消してから rmdir で失敗するため、**部分的に壊れたディレクトリが残る**）。
  一方、`writeFile` による上書きと `unlink` は**可**。`openSync(path, 'wx')` の排他作成も可で、
  存在すれば EEXIST。ただし **`unlink` した名前をすぐ作り直すと EPERM**（削除がペンディングのまま
  名前が解放されない）。**名前を再利用する設計は取れない**。

  **世代番号つきファイル名の掃除**: gen 1 を別プロセスに握らせたまま gen 2〜21 を作り、毎回 1 つ前を
  `unlink` する 20 サイクルを Windows で実施。**`unlink` の失敗 0 件、積み残し 0 件**。握られている
  世代は `readdir` に残るが `existsSync` は false で、holder 終了時に OS が自動で消す。掃除ロジックは
  不要。名前を再利用しないので上記の EPERM も踏まない。

  **seqlock（状態ファイル + 読み手の世代再確認）の検証**: 世代番号が単調増加なら ABA は起きない。
  書き手が実物の `finish()` を回し続ける中で読み手が読む形で測ったところ、**混在の受理は全条件で
  0 件**。書き手 100ms 間隔で読み手は 4,498 回成功し、再試行は再構築 1 回につき 1 回程度。
  ただし 11.7ms 間隔という極端な条件では読み手が一度も成功できず（starvation）、500ms 間隔でも
  再試行 50 回を使い切る事例が 19 回中 1 回あった。**再試行の上限は恣意的なパラメータになる**。
