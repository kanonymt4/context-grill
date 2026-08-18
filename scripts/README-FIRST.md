# context-grill セットアップ手順

GitHub / Confluence / Jira / 手元のフォルダを一次資料として、根拠付きで調査・設計を行う CLI ツールです。

---

## 必要なもの

- **Node.js 20.10 以上**（https://nodejs.org/）
- git（GitHub リポジトリを直接取得する場合のみ。手元のフォルダを対象にするなら不要）

管理者権限は不要です。

---

## 手順（3ステップ）

### 1. インストール

このフォルダで次を実行します。

```
npm install -g ./context-grill-0.1.0.tgz
```

確認：

```
context-grill --help
```

**`context-grill が見つからない` と出た場合** — npm のインストール先に PATH が通っていません。

**Windows（PowerShell）**

次の2行で、自分のユーザー環境変数の Path に追加できます。管理者権限は不要です。

```
$p = [Environment]::GetEnvironmentVariable('Path','User')
[Environment]::SetEnvironmentVariable('Path', "$(npm config get prefix);$p", 'User')
```

実行後、**PowerShell を閉じて開き直す**と反映されます。

> **`setx` は使わないでください。** 1024文字を超える PATH を切り詰めて壊すことが知られています。
> 上の `[Environment]::SetEnvironmentVariable` には、その制限はありません。

> GUI（「システム環境変数の編集」→「環境変数」）からも設定できますが、UAC の状態によっては
> ボタンがグレーアウトして編集できないことがあります。

**PATH を変更したくない場合**は、インストール先を直接指定して実行することもできます。

```
& "$(npm config get prefix)\context-grill.cmd" --help
```

**macOS / Linux**

`~/.zshrc`（bash なら `~/.bashrc`）に次の1行を追記して、新しいターミナルを開きます。

```
export PATH="$(npm config get prefix)/bin:$PATH"
```

**`EACCES` エラーが出た場合**（macOS / Linux でよくあります）

```
npm config set prefix ~/.npm-global
npm install -g ./context-grill-0.1.0.tgz
```

そのうえで上記の PATH 設定を行ってください。

### 2. 作業フォルダを作って初期化

```
mkdir my-project
cd my-project
context-grill init
```

`init` を実行すると、そのフォルダに次が作られます。

| ファイル | 内容 |
| --- | --- |
| `context-grill.config.json` | 調査対象の設定。次のステップで編集します |
| `.env.example` | 認証情報のテンプレート |
| `commands.md` | **コマンドとオプションの一覧・使用例** |
| `usage.md` | **調査対象の指定方法（詳しい説明はこちら）** |

画面にも次の手順が表示されるので、そのまま進めれば動きます。

### 3. 調査対象を設定して使う

`context-grill.config.json` を開き、`sources` を書き換えます。
**雛形には local / GitHub / Confluence の3種類が入っているので、使うものだけ残して他は削除してください。**
ダミーのまま `sync` するとエラーになります。

**手元のフォルダを対象にする場合**（認証不要・外部通信なし）

```json
"sources": [
  { "id": "proj", "type": "local", "path": "../my-repo",
    "include": ["src/**", "docs/**", "*.md"],
    "exclude": ["**/node_modules/**"] }
]
```

ネットワーク制限で GitHub に直接つなげない場合は、clone 済みのフォルダをこの形で指定します。

**GitHub リポジトリを対象にする場合**

```json
"sources": [
  { "id": "repo", "type": "github", "repo": "owner/name", "ref": "main" }
]
```

`id` は自分で決める呼び名です。実際のリポジトリ名と一致させる必要はありません。

設定できたら索引を作ります。

```
context-grill doctor      環境と設定を確認（✗ が出ても、使わない機能のものは無視して構いません）
context-grill sync        資料を取得して索引を構築
context-grill search "キーワード"
```

ここまで**認証情報なし**で動きます。

---

## 認証情報が必要になったら

`.env.example` を `.env` にコピーして編集します。作業フォルダの直下に置いてください。

| 変数 | 必要な場面 |
| --- | --- |
| `GITHUB_TOKEN` | private リポジトリを取得する場合（git の資格情報が設定済みなら不要なことがあります） |
| `ATLASSIAN_EMAIL` / `ATLASSIAN_API_TOKEN` | Confluence / Jira を対象にする場合 |
| `ANTHROPIC_API_KEY` | `ask` で回答を生成する場合 |

`search` / `scan` / `ask --dry-run` だけなら、いずれも不要です。

---

## 使いはじめの目安

**検索する**（LLM 不使用・キー不要・無料）

```
context-grill search "リトライ 上限"
```

**機械的にチェックする**（LLM 不使用・毎回同じ結果）

```
context-grill scan --severity medium
```

**調査させる**

```
context-grill ask "認証まわりの仕様を整理して" --task spec
```

`--dry-run --out bundle.md` を付けると、**LLM を呼ばずに**プロンプトと証拠一式をファイルに出力します。
API キーがなくても使え、生成された `bundle.md` を任意の LLM に読ませれば同じことができます。

```
context-grill ask "設計に穴がないか検証して" --task spec --effort deep --dry-run --out bundle.md
```

詳しい使い方は、作業フォルダにできる **`commands.md`**（コマンド一覧）と **`usage.md`**（対象の指定方法）を参照してください。
