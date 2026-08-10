#!/usr/bin/env sh
# context-grill セットアップスクリプト（macOS / Linux）
#
# やること:
#   1. Node.js 20+ の確認
#   2. context-grill のグローバルインストール（EACCES 時は prefix 方式にフォールバック）
#   3. 作業ディレクトリの作成と context-grill init
#   4. doctor で状態表示
#
# やらないこと（意図的に人間に任せる）:
#   - ~/.zshrc などシェル設定ファイルの書き換え（必要なら手順を表示するだけ）
#   - context-grill.config.json の sources 編集（対象は人によって違う）
#   - .env への認証情報の記入（秘密情報をスクリプトに扱わせない）
#
# 使い方:
#   sh setup.sh                       # カレントに作業ディレクトリを作る
#   sh setup.sh ~/work/my-project     # 場所を指定する

set -eu

TGZ_GLOB='context-grill-*.tgz'
WORKDIR="${1:-./context-grill-workspace}"

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '[!] %s\n' "$*" >&2; }
die()  { printf '[x] %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. Node 確認
step "Node.js を確認しています"

command -v node >/dev/null 2>&1 || die "node が見つかりません。Node.js 20.10 以上を入れてください: https://nodejs.org/"
command -v npm  >/dev/null 2>&1 || die "npm が見つかりません。Node.js を入れ直してください。"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node.js 20.10 以上が必要です（現在: $(node -v)）"
fi
say "OK: $(node -v)"

if command -v git >/dev/null 2>&1; then
  say "OK: $(git --version)"
else
  warn "git が見つかりません。GitHub ソースを clone モードで使う場合は必要です（ローカルソースのみなら不要）。"
fi

# -------------------------------------------------- 2. インストール（冪等）
step "context-grill をインストールします"

if command -v context-grill >/dev/null 2>&1; then
  say "既にインストール済みです: $(command -v context-grill)"
  say "再インストールする場合は先に 'npm uninstall -g context-grill' を実行してください。"
else
  # スクリプトと同じディレクトリの .tgz を探す（無ければカレント）
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  TGZ=$(ls "$SCRIPT_DIR"/$TGZ_GLOB 2>/dev/null | head -1 || true)
  [ -n "${TGZ:-}" ] || TGZ=$(ls ./$TGZ_GLOB 2>/dev/null | head -1 || true)

  if [ -n "${TGZ:-}" ]; then
    say "パッケージ: $TGZ"
    INSTALL_TARGET="$TGZ"
  else
    # .tgz が無ければ、このリポジトリ自体をインストールする
    SCRIPT_PARENT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
    if [ -f "$SCRIPT_PARENT/package.json" ]; then
      say "パッケージが見つからないため、リポジトリから直接インストールします: $SCRIPT_PARENT"
      INSTALL_TARGET="$SCRIPT_PARENT"
    else
      die "context-grill-*.tgz が見つかりません。配布された .tgz と同じ場所でこのスクリプトを実行してください。"
    fi
  fi

  if npm install -g "$INSTALL_TARGET" 2>/tmp/cg_install_err.log; then
    say "OK: グローバルインストールが完了しました"
  elif grep -q 'EACCES' /tmp/cg_install_err.log 2>/dev/null; then
    warn "グローバル領域への書き込み権限がありません（EACCES）。ユーザー領域にインストールし直します。"

    NPM_PREFIX="$HOME/.npm-global"
    npm config set prefix "$NPM_PREFIX"
    npm install -g "$INSTALL_TARGET" || die "インストールに失敗しました。/tmp/cg_install_err.log を確認してください。"

    say "OK: $NPM_PREFIX にインストールしました"

    # PATH は自動で書き換えない。必要な操作を提示するだけ。
    case ":${PATH}:" in
      *":$NPM_PREFIX/bin:"*) ;;
      *)
        SHELL_RC="$HOME/.bashrc"
        case "${SHELL:-}" in *zsh) SHELL_RC="$HOME/.zshrc" ;; esac
        say ""
        warn "PATH が通っていません。次の1行をご自身で $SHELL_RC に追記してください:"
        say ""
        say "    export PATH=\"$NPM_PREFIX/bin:\$PATH\""
        say ""
        say "追記後、新しいターミナルを開くか 'source $SHELL_RC' を実行してください。"
        PATH="$NPM_PREFIX/bin:$PATH"
        export PATH
        ;;
    esac
  else
    cat /tmp/cg_install_err.log >&2 || true
    die "インストールに失敗しました。"
  fi
  rm -f /tmp/cg_install_err.log
fi

# インストールは成功したが PATH が通っていない場合の案内。
# EACCES が起きなかった場合でも、npm の prefix に PATH が通っていないことがある。
if ! command -v context-grill >/dev/null 2>&1; then
  NPM_BIN=$(npm config get prefix 2>/dev/null)/bin
  if [ -x "$NPM_BIN/context-grill" ]; then
    SHELL_RC="$HOME/.bashrc"
    case "${SHELL:-}" in *zsh) SHELL_RC="$HOME/.zshrc" ;; esac
    say ""
    warn "インストールは成功しましたが、PATH が通っていません。"
    warn "次の1行をご自身で $SHELL_RC に追記してください:"
    say ""
    say "    export PATH=\"$NPM_BIN:\$PATH\""
    say ""
    say "追記後、新しいターミナルを開くか 'source $SHELL_RC' を実行してください。"
    say "（このスクリプトは PATH を一時的に通して続行します）"
    PATH="$NPM_BIN:$PATH"
    export PATH
  fi
fi

command -v context-grill >/dev/null 2>&1 || die "context-grill コマンドが見つかりません。上記の PATH 設定を行ってから、もう一度実行してください。"

# ------------------------------------------------ 3. 作業ディレクトリと init
step "作業ディレクトリを準備します: $WORKDIR"

mkdir -p "$WORKDIR"
cd "$WORKDIR"

if [ -f context-grill.config.json ]; then
  say "context-grill.config.json は既にあります（上書きしません）"
else
  context-grill init
fi

# .gitignore は init が「手動で追加してください」と案内するだけなので、
# 作業ディレクトリが git 管理下のときだけ、不足していれば追記する。
if [ -d .git ] || git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  for line in ".env" ".context-grill/"; do
    if ! grep -qxF "$line" .gitignore 2>/dev/null; then
      printf '%s\n' "$line" >> .gitignore
      say ".gitignore に $line を追加しました"
    fi
  done
fi

# ------------------------------------------------------------- 4. doctor
step "環境チェック（context-grill doctor）"
context-grill doctor || true

# ------------------------------------------------------------- 案内
cat <<'GUIDE'

==> セットアップはここまでです。以降はご自身で設定してください。

1. 調査対象を設定する
     $EDITOR context-grill.config.json

   sources を書き換えます:
     GitHub   { "id": "repo", "type": "github", "repo": "owner/name", "ref": "main" }
     ローカル  { "id": "proj", "type": "local",  "path": "/path/to/dir" }

   URL から自動生成することもできます:
     context-grill resolve "https://github.com/owner/name" --add

2. 認証情報を用意する（必要な場合のみ）
     cp .env.example .env && $EDITOR .env

     GITHUB_TOKEN        private リポジトリを見る場合
                         （git の資格情報ヘルパーが設定済みなら不要なことがあります）
     ANTHROPIC_API_KEY   ask コマンドで根拠付きレポートを作る場合
     ※ search / scan だけならどちらも不要です

3. 索引を作って使う
     context-grill doctor              # ✗ が残っていないか確認
     context-grill sync                # 資料を取得して索引を構築
     context-grill search "キーワード"   # LLM 不使用・API キー不要

詳細は README.md の 7 章（対象の指定方法）と usage.md を参照してください。
GUIDE
