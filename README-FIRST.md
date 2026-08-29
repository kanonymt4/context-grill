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
npm install -g ./context-grill-0.1.1.tgz
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
npm install -g ./context-grill-0.1.1.tgz
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

## 2つ目以降のプロジェクトを調べるとき

**`npm install -g` は最初の1回だけ**で構いません。一度入れれば、どのフォルダからでも
`context-grill` コマンドが使えます。

別の対象を調べたくなったら、新しいフォルダを作って `init` から始めてください。

```
mkdir ~/work/project-B && cd ~/work/project-B
context-grill init
# sources を編集してから
context-grill sync
```

作業フォルダごとに、次のものが独立します。索引が混ざることはありません。

| もの | 扱い |
| --- | --- |
| `context-grill.config.json`（調査対象） | フォルダごとに独立 |
| `.context-grill/`（索引・キャッシュ・実行結果） | フォルダごとに独立 |
| `commands.md` / `usage.md` | `init` が各フォルダにコピー |
| `.env`（認証情報） | フォルダごとに独立（下記の方法で共通化できます） |

### 認証情報を使い回す

作業フォルダごとに `.env` を作るのが面倒な場合は、シェルの設定に書いておけば共通で使えます。

```
# ~/.zshrc（bash なら ~/.bashrc）に一度だけ書く
export GITHUB_TOKEN="..."
export ANTHROPIC_API_KEY="..."
```

`.env` は「すでに環境変数があれば上書きしない」動作なので、シェル側に書いておけば
どの作業フォルダでも自動的に使われます。

逆に言うと、**シェル側に `export` した値のほうが `.env` より優先されます**。
プロジェクトごとに違うトークンを使い分けたい場合は、シェル側には書かず、
各フォルダの `.env` に書いてください。

### バージョンを更新するとき

新しい `.tgz` を受け取ったら、インストールし直すだけです。

```
npm install -g ./context-grill-0.1.1.tgz
```

**既存の作業フォルダはそのまま使えます。** `init` のやり直しも、新しいフォルダの作成も、
索引の作り直しも不要です。更新後すぐに `search` や `ask` を続けられます。

| よくある疑問 | 答え |
| --- | --- |
| `init` をやり直す必要は？ | **不要**。設定も索引もそのまま有効です |
| 別のフォルダを作り直す必要は？ | **不要**。同じフォルダを使い続けてください |
| `sync` をやり直す必要は？ | **不要**。調査対象の中身が変わったときだけ実行します |
| 設定ファイルは書き換わる？ | いいえ。`init` を実行しても既存ファイルは上書きされません |

索引は**ツールのバージョンではなく設定内容**（`sources`・チャンク設定・埋め込み設定）に
紐づいているため、設定を変えていなければ再構築は不要です。

### 更新後にドキュメントも新しくしたい場合

`commands.md` と `usage.md` は `init` のときにコピーされたものなので、作業フォルダ内は
古いままです。最新版を読みたい場合だけ、その2つを消して `init` し直してください。

```
rm commands.md usage.md
context-grill init
```
