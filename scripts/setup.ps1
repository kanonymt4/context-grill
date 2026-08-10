<#
.SYNOPSIS
  context-grill セットアップスクリプト（Windows / PowerShell）

.DESCRIPTION
  やること:
    1. Node.js 20+ の確認
    2. context-grill のグローバルインストール
    3. 作業ディレクトリの作成と context-grill init
    4. doctor で状態表示

  やらないこと（意図的に人間に任せる）:
    - PowerShell プロファイルや環境変数 PATH の書き換え（必要なら手順を表示するだけ）
    - context-grill.config.json の sources 編集（対象は人によって違う）
    - .env への認証情報の記入（秘密情報をスクリプトに扱わせない）

.EXAMPLE
  .\setup.ps1
  .\setup.ps1 -WorkDir C:\work\my-project

.NOTES
  実行できない場合は次のいずれかで:
    powershell -ExecutionPolicy Bypass -File .\setup.ps1
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#>

param(
    [string]$WorkDir = ".\context-grill-workspace"
)

$ErrorActionPreference = 'Stop'

function Write-Step { param($m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host $m }
function Write-Warn { param($m) Write-Host "[!] $m" -ForegroundColor Yellow }
function Die        { param($m) Write-Host "[x] $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. Node 確認
Write-Step "Node.js を確認しています"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "node が見つかりません。Node.js 20.10 以上を入れてください: https://nodejs.org/"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Die "npm が見つかりません。Node.js を入れ直してください。"
}

$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 20) {
    Die "Node.js 20.10 以上が必要です（現在: $(node -v)）"
}
Write-Ok "OK: $(node -v)"

if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Ok "OK: $(git --version)"
} else {
    Write-Warn "git が見つかりません。GitHub ソースを clone モードで使う場合は必要です（ローカルソースのみなら不要）。"
}

# -------------------------------------------------- 2. インストール（冪等）
Write-Step "context-grill をインストールします"

if (Get-Command context-grill -ErrorAction SilentlyContinue) {
    Write-Ok "既にインストール済みです: $((Get-Command context-grill).Source)"
    Write-Ok "再インストールする場合は先に 'npm uninstall -g context-grill' を実行してください。"
} else {
    # スクリプトと同じディレクトリの .tgz を探す（無ければカレント）
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $tgz = Get-ChildItem -Path $scriptDir -Filter 'context-grill-*.tgz' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $tgz) {
        $tgz = Get-ChildItem -Path . -Filter 'context-grill-*.tgz' -ErrorAction SilentlyContinue | Select-Object -First 1
    }

    if ($tgz) {
        Write-Ok "パッケージ: $($tgz.FullName)"
        $installTarget = $tgz.FullName
    } else {
        # .tgz が無ければ、このリポジトリ自体をインストールする
        $repoRoot = Split-Path -Parent $scriptDir
        if (Test-Path (Join-Path $repoRoot 'package.json')) {
            Write-Ok "パッケージが見つからないため、リポジトリから直接インストールします: $repoRoot"
            $installTarget = $repoRoot
        } else {
            Die "context-grill-*.tgz が見つかりません。配布された .tgz と同じ場所でこのスクリプトを実行してください。"
        }
    }

    npm install -g $installTarget
    if ($LASTEXITCODE -ne 0) {
        Die "インストールに失敗しました。管理者権限の PowerShell で再実行するか、npm のエラー出力を確認してください。"
    }
    Write-Ok "OK: グローバルインストールが完了しました"

    # npm のグローバル bin に PATH が通っているか確認（自動で書き換えはしない）
    if (-not (Get-Command context-grill -ErrorAction SilentlyContinue)) {
        $npmPrefix = (npm config get prefix).Trim()
        Write-Host ""
        Write-Warn "PATH が通っていないようです。次のディレクトリを PATH に追加してください:"
        Write-Host ""
        Write-Host "    $npmPrefix"
        Write-Host ""
        Write-Host "「システム環境変数の編集」→「環境変数」→ ユーザー環境変数の Path に追加し、"
        Write-Host "新しい PowerShell を開いてから、もう一度このスクリプトを実行してください。"
        exit 1
    }
}

if (-not (Get-Command context-grill -ErrorAction SilentlyContinue)) {
    Die "context-grill コマンドが見つかりません。上記の PATH 設定を行ってから、もう一度実行してください。"
}

# ------------------------------------------------ 3. 作業ディレクトリと init
Write-Step "作業ディレクトリを準備します: $WorkDir"

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Set-Location $WorkDir

if (Test-Path 'context-grill.config.json') {
    Write-Ok "context-grill.config.json は既にあります（上書きしません）"
} else {
    context-grill init
}

# 作業ディレクトリが git 管理下のときだけ .gitignore を補う
$inGitRepo = $false
if (Test-Path '.git') {
    $inGitRepo = $true
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
    git rev-parse --is-inside-work-tree 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $inGitRepo = $true }
}

if ($inGitRepo) {
    foreach ($line in @('.env', '.context-grill/')) {
        $existing = if (Test-Path '.gitignore') { Get-Content '.gitignore' } else { @() }
        if ($existing -notcontains $line) {
            Add-Content -Path '.gitignore' -Value $line
            Write-Ok ".gitignore に $line を追加しました"
        }
    }
}

# ------------------------------------------------------------- 4. doctor
Write-Step "環境チェック（context-grill doctor）"
context-grill doctor

# ------------------------------------------------------------- 案内
Write-Host @'

==> セットアップはここまでです。以降はご自身で設定してください。

1. 調査対象を設定する
     notepad context-grill.config.json

   sources を書き換えます:
     GitHub   { "id": "repo", "type": "github", "repo": "owner/name", "ref": "main" }
     ローカル  { "id": "proj", "type": "local",  "path": "C:/path/to/dir" }

   URL から自動生成することもできます:
     context-grill resolve "https://github.com/owner/name" --add

2. 認証情報を用意する（必要な場合のみ）
     Copy-Item .env.example .env; notepad .env

     GITHUB_TOKEN        private リポジトリを見る場合
                         （git の資格情報ヘルパーが設定済みなら不要なことがあります）
     ANTHROPIC_API_KEY   ask コマンドで根拠付きレポートを作る場合
     ※ search / scan だけならどちらも不要です

3. 索引を作って使う
     context-grill doctor              # ✗ が残っていないか確認
     context-grill sync                # 資料を取得して索引を構築
     context-grill search "キーワード"   # LLM 不使用・API キー不要

詳細は README.md の 7 章（対象の指定方法）と usage.md を参照してください。
'@
