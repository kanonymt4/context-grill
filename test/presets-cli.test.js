import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { syncSources, buildIndex } from '../src/index/ingest.js';
import { listPresets, validatePresets, resolvePreset } from '../src/presets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'context-grill.js');

// ---------------------------------------------------------------- 共通準備
const SOURCES = [
  { id: 'api', type: 'local', path: 'api', include: ['**/*'], includeUnknownTypes: true },
  { id: 'web', type: 'local', path: 'web', include: ['**/*'], includeUnknownTypes: true },
  { id: 'docs', type: 'local', path: 'docs', include: ['**/*'], includeUnknownTypes: true },
];

const BUG_TRIAGE = {
  name: 'bug-triage',
  description: '障害の原因調査',
  task: 'bug',
  effort: 'deep',
  sources: ['api', 'docs'],
  instruction: '{{symptom}} の原因を調べて。「timeout」「retry」「{{component}}」まわりを見たい',
  arguments: [
    { name: 'symptom', description: '症状' },
    { name: 'component', description: '対象', required: false, default: 'エラー処理' },
  ],
};

// anthropic 設定。ゲートが壊れても実際の API に届かないよう、送信先は .invalid にする
const ANTHROPIC = { provider: 'anthropic', model: 'm', apiKeyEnv: 'CG_RUN_TEST_LLM_KEY', baseUrl: 'https://llm.invalid' };

/**
 * 一時ディレクトリに local ソース api / web と設定を置き、同一プロセス内で索引まで作る。
 * 索引が無いと「索引が無い」エラーが本来の失敗理由を隠すため。
 */
async function makeProject({ presets, llm = { provider: 'dry', model: 'd' }, security, noIndex = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-presets-cli-'));
  await fsp.mkdir(path.join(dir, 'api'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'web'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'docs', 'guide.md'), '# guide\n\ntimeout retry の方針: docs-timeout-retry\n');
  await fsp.writeFile(path.join(dir, 'api', 'handler.js'), 'export function handler() { /* timeout retry */ return "api-timeout-retry"; }\n');
  await fsp.writeFile(path.join(dir, 'web', 'page.js'), 'export function page() { /* timeout retry */ return "web-timeout-retry"; }\n');
  const file = path.join(dir, 'context-grill.config.json');
  const body = { project: 'x', sources: SOURCES, llm };
  if (presets !== undefined) body.presets = presets;
  if (security !== undefined) body.security = security;
  await fsp.writeFile(file, JSON.stringify(body));
  if (!noIndex) {
    const config = await loadConfig(file);
    await syncSources(config, {});
    await buildIndex(config, { embed: false });
  }
  return { dir, file };
}

/** 子プロセスの環境。リポジトリ直下の .env は cwd と -c で避け、キー類は消す */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CONTEXT_GRILL_LOG_LEVEL', 'CG_RUN_TEST_LLM_KEY']) delete env[k];
  return { ...env, ...extra };
}

/** -c は先頭に置く（`--` より後ろに回ると位置引数として扱われてしまうため） */
function cli(proj, args, { env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, '-c', proj.file, ...args], {
    cwd: proj.dir, encoding: 'utf8', env: cleanEnv(env),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const cleanup = (proj) => fsp.rm(proj.dir, { recursive: true, force: true });
const egressLog = (proj) => path.join(proj.dir, '.context-grill', 'egress.log');
const runsDir = (proj) => path.join(proj.dir, '.context-grill', 'runs');
const runCount = (proj) => (fs.existsSync(runsDir(proj)) ? fs.readdirSync(runsDir(proj)).length : 0);

/** 一時ディレクトリ上のプロジェクトで fn を実行して後始末する */
async function withProject(opts, fn) {
  const proj = await makeProject(opts);
  try {
    return await fn(proj);
  } finally {
    await cleanup(proj);
  }
}

/** 失敗を想定する実行の確認。「未知のコマンド」で落ちているだけの空振りを防ぐ */
function assertFails(r, re) {
  assert.equal(r.status, 1, `終了コード: ${r.status}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, re);
  assert.doesNotMatch(r.stderr, /未知のコマンド/);
}

const json = (r) => {
  assert.equal(r.status, 0, `終了コード: ${r.status}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

// 変更前の HELP（行単位）。run / presets の追加は行の追加だけで、既存の行は変えない
const OLD_HELP_LINES = [
  'context-grill — GitHub と Atlassian の一次資料に基づいて調査・設計を行うツール',
  '使い方:',
  '  context-grill <コマンド> [オプション]',
  'コマンド:',
  '  init                      設定のひな形とドキュメントを作業ディレクトリに配置',
  '  resolve <URL...>          ブラウザのURLを貼ると sources 定義を生成（--add で設定に追記）',
  '  sync                      ソースを取得して索引を再構築',
  '  build                     取得済みキャッシュから索引だけ再構築（ネットワーク不要）',
  '  status                    索引とソースの状態を表示',
  '  search <クエリ>           ハイブリッド検索（LLM を使わない・トークン消費ゼロ）',
  '  scan                      静的解析（LLM を使わない・毎回同じ結果）',
  '  ask <指示>                証拠付きで調査・回答を生成',
  '  tasks                     利用可能なタスク種別を表示',
  '  mcp                       MCP サーバーとして起動（stdio）',
  '  doctor                    実行環境と設定の健全性チェック',
  '  privacy                   どのデータがどこへ送られるかを表示（送信前の監査用）',
  '共通オプション:',
  '  -c, --config <path>       設定ファイルのパス',
  '  --source <id>             対象ソースを限定（カンマ区切り）',
  '  --json                    JSON で出力',
  '  --log <level>             silent|error|warn|info|debug',
  '  --offline                 一切の外部通信を禁止（検索・静的解析・--dry-run のみ動作）',
  'sync:',
  '  --full                    キャッシュを無視して全件再取得',
  '  --no-embed                埋め込み生成をスキップ',
  'search:',
  '  -k, --top <n>             返す件数 (既定 20)',
  '  --raw                     墨消しを無効化して原文を表示（取り扱い注意）',
  'scan:',
  '  --severity <lv>           critical|high|medium|low|info（既定 low 以上）',
  '  --out <file>              結果を書き出す',
  'ask:',
  '  -t, --task <id>           spec|bug|security|static|design（既定 spec）',
  '  -e, --effort <lv>         low|normal|deep（既定 normal）',
  '  -m, --model <name>        モデルを一時的に上書き',
  '  --dry-run                 LLM を呼ばずにプロンプト+証拠バンドルのみ生成（トークン 0）',
  '  --out <file>              レポートの保存先',
  '例:',
  '  context-grill sync',
  "  context-grill ask '決済リトライの仕様を整理して。「リトライ上限」「冪等性」を確認' --task spec",
  "  context-grill ask '500 エラーの原因を調べて。「タイムアウト」「コネクション」を見たい' --task bug --effort deep",
  "  context-grill ask '認証まわりのリスク。「トークン」「権限チェック」を確認' --task security --dry-run",
  '  指示文で調べたい概念を「」や "" で囲むと、それぞれが独立した検索クエリになります。',
  '  囲まないと実質 4 クエリしか生成されません（詳細は commands.md）。',
];

// ============================================================ R0. 回帰ガード（ask の既存挙動）
test('R0a: ask --dry-run --json は現行どおりのキー集合で、meta.queries[0] が指示文と一致する', () => withProject({}, async (proj) => {
  const out = json(cli(proj, ['ask', 'timeout retry を調べて', '--dry-run', '--json']));
  // dry-run では result / verification が undefined で JSON から落ちる（実測）
  assert.deepEqual(Object.keys(out).sort(), ['evidence', 'meta', 'runId']);
  assert.equal(out.meta.queries[0], 'timeout retry を調べて');
  assert.ok(out.evidence.length > 0);
}));

test('R0b: ask --dry-run のテキスト出力は bundle を stdout に、実行結果の場所を stderr に出す', () => withProject({}, async (proj) => {
  const r = cli(proj, ['ask', 'timeout retry', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<evidence id="E1"/);
  assert.match(r.stderr, /実行結果一式:/);
}));

test('R0c: ask --task nope は未知のタスクで終了 1', () => withProject({}, async (proj) => {
  const r = cli(proj, ['ask', 'x', '--task', 'nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未知のタスク: nope/);
}));

test('R0d: ask --dry-run --out でファイルができ、stderr に保存の旨が出る', () => withProject({}, async (proj) => {
  const out = path.join(proj.dir, 'o.md');
  const r = cli(proj, ['ask', 'timeout retry', '--dry-run', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.statSync(out).size > 0);
  assert.match(r.stderr, /レポートを保存しました/);
}));

test('R0e: anthropic かつ allowLlmUpload=false なら、--dry-run なしの ask は送信前にブロックされる', () =>
  withProject({ llm: ANTHROPIC, security: { allowLlmUpload: false } }, async (proj) => {
    const r = cli(proj, ['ask', 'timeout retry'], { env: { CG_RUN_TEST_LLM_KEY: 'dummy' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /allowLlmUpload=false/);
    assert.ok(!fs.existsSync(egressLog(proj)), '通信は起きていない');
  }));

test('R0f: --help は変更前の HELP の行をすべて含む', () => withProject({ noIndex: true }, async (proj) => {
  const r = cli(proj, ['--help']);
  assert.equal(r.status, 0);
  const lines = new Set(r.stdout.split('\n'));
  for (const l of OLD_HELP_LINES) assert.ok(lines.has(l), `HELP から行が消えています: ${l}`);
}));

// ============================================================ 共通のプロジェクト（preset 入り）
const OPT_ONLY = {
  name: 'opt-only', task: 'bug', instruction: '{{opt}}',
  arguments: [{ name: 'opt', required: false, default: '' }],
};
const NO_ARGS = { name: 'no-args', task: 'spec', effort: 'low', instruction: 'timeout retry' };

let sharedPromise = null;
const shared = () => (sharedPromise ??= makeProject({ presets: [BUG_TRIAGE, OPT_ONLY, NO_ARGS] }));
test.after(async () => { if (sharedPromise) await cleanup(await sharedPromise); });

const expand = (v, component = 'エラー処理') => `${v} の原因を調べて。「timeout」「retry」「${component}」まわりを見たい`;

// ============================================================ 正常系
test('T1: run --dry-run --json は展開後の指示・effort・ソース絞り込みが効き、preset キーが付く', async () => {
  const proj = await shared();
  // 絞り込み無しなら web も証拠に入ることを先に確認する（空振り防止）
  const all = json(cli(proj, ['ask', 'timeout retry', '--task', 'bug', '--dry-run', '--json']));
  assert.ok(new Set(all.evidence.map((e) => e.label.split('/')[0])).has('web'), '前提: 絞り込み無しなら web が入る');

  const out = json(cli(proj, ['run', 'bug-triage', 'symptom=タイムアウト', '--dry-run', '--json']));
  assert.equal(out.meta.queries[0], expand('タイムアウト'));
  assert.equal(out.meta.effort, 'deep');
  assert.ok(out.evidence.length > 0);
  // 複数ソースの指定が先頭 1 件に切り詰められていないこと（api と docs が両方残り、web は無い）
  assert.deepEqual(
    [...new Set(out.evidence.map((e) => e.label.split('/')[0]))].sort(),
    ['api', 'docs'],
    JSON.stringify(out.evidence.map((e) => e.label)),
  );
  assert.deepEqual(out.preset, {
    name: 'bug-triage',
    args: { symptom: 'タイムアウト' },
    task: 'bug',
    effort: 'deep',
    sources: ['api', 'docs'],
    instruction: expand('タイムアウト'),
  });
  // ask の出力キーは保ったまま preset だけが増える
  assert.deepEqual(Object.keys(out).sort(), ['evidence', 'meta', 'preset', 'runId']);
});

test('T2: テキスト出力は stdout に bundle、stderr に展開結果を出す', async () => {
  const proj = await shared();
  const r = cli(proj, ['run', 'bug-triage', 'symptom=タイムアウト', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<evidence id="E1"/);
  assert.match(r.stderr, /preset "bug-triage": task=bug effort=deep sources=api,docs$/m);
  assert.ok(r.stderr.includes(`指示: ${expand('タイムアウト')}`), r.stderr);
  assert.match(r.stderr, /実行結果一式:/);
  // 複数行の指示は 2 行目以降を字下げして出す（接頭辞の無い行が混ざらない）
  const multi = cli(proj, ['run', 'bug-triage', 'symptom=一行目\n二行目', '--dry-run']);
  assert.equal(multi.status, 0, multi.stderr);
  assert.ok(multi.stderr.includes('指示: 一行目\n      二行目 の原因を調べて'), multi.stderr);
});

test('T3: --log warn では展開結果が出ない', async () => {
  const proj = await shared();
  const loud = cli(proj, ['run', 'bug-triage', 'symptom=x', '--dry-run']);
  assert.match(loud.stderr, /preset "bug-triage"/, '前提: 既定では出る');
  const quiet = cli(proj, ['run', 'bug-triage', 'symptom=x', '--dry-run', '--log', 'warn']);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /preset "bug-triage"/);
  assert.doesNotMatch(quiet.stderr, /指示:/);
});

test('T4: 値の境界（空白・= ・先頭の - ・日本語・引用符・$& ）がそのまま指示文に入る', async () => {
  const proj = await shared();
  const values = ['a b', 'a=b', '-x', '日本語', '"q" \'s\'', '$&', '$1 $$', '{{component}}'];
  for (const v of values) {
    const out = json(cli(proj, ['run', 'bug-triage', `symptom=${v}`, '--dry-run', '--json']));
    assert.equal(out.meta.queries[0], expand(v).trim(), `値: ${v}`);
    assert.equal(out.preset.args.symptom, v);
  }
  // 任意引数: 省略・空文字は default、指定すれば上書き
  const omitted = json(cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '--json']));
  assert.equal(omitted.meta.queries[0], expand('s', 'エラー処理'));
  const empty = json(cli(proj, ['run', 'bug-triage', 'symptom=s', 'component=', '--dry-run', '--json']));
  assert.equal(empty.meta.queries[0], expand('s', 'エラー処理'));
  const given = json(cli(proj, ['run', 'bug-triage', 'symptom=s', 'component=決済', '--dry-run', '--json']));
  assert.equal(given.meta.queries[0], expand('s', '決済'));
});

test('T5: フラグと引数の順序に依存しない。-- より後ろの語も引数になる', async () => {
  const proj = await shared();
  const a = json(cli(proj, ['--dry-run', '--json', 'run', 'bug-triage', 'symptom=s']));
  const b = json(cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '--json']));
  assert.equal(a.meta.queries[0], b.meta.queries[0]);
  assert.equal(a.meta.queries[0], expand('s'));
  const c = json(cli(proj, ['run', 'bug-triage', '--dry-run', '--json', '--', 'symptom=-x', 'component=--y']));
  assert.equal(c.meta.queries[0], expand('-x', '--y'));
  // 実運用の呼び方: -c を末尾に置く（cli() は先頭に置くので spawnSync を直接呼ぶ）
  const tail = spawnSync(process.execPath, [CLI, 'run', 'bug-triage', 'symptom=s', '--dry-run', '--json', '-c', proj.file], {
    cwd: proj.dir, encoding: 'utf8', env: cleanEnv(),
  });
  assert.equal(tail.status, 0, tail.stderr);
  assert.equal(JSON.parse(tail.stdout).meta.queries[0], expand('s'));
});

test('T6: --out でファイルに書きつつ stdout にも出る', async () => {
  const proj = await shared();
  const out = path.join(proj.dir, 'run-out.md');
  const r = cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<evidence id="E1"/);
  assert.match(r.stderr, /レポートを保存しました/);
  assert.equal(fs.readFileSync(out, 'utf8') + '\n', r.stdout);
});

// ============================================================ エラー系
test('E1: 名前なしは定義済みの一覧つきで終了 1', async () => {
  const proj = await shared();
  const before = runCount(proj);
  const r = cli(proj, ['run']);
  assertFails(r, /preset 名を指定/);
  assert.match(r.stderr, /定義済み: bug-triage/);
  assert.match(r.stderr, /context-grill presets/);
  assert.equal(runCount(proj), before);
});

test('E2: 未定義の名前は定義済みの一覧と presets への案内つき', async () => {
  const proj = await shared();
  const before = runCount(proj);
  const r = cli(proj, ['run', 'nope', '--dry-run']);
  assertFails(r, /preset "nope" は定義されていません（定義済み:/);
  assert.match(r.stderr, /context-grill presets/);
  assert.equal(runCount(proj), before);
});

test('E3: 必須引数なしは使い方の行つき', async () => {
  const proj = await shared();
  const before = runCount(proj);
  const r = cli(proj, ['run', 'bug-triage', '--dry-run']);
  assertFails(r, /必須の引数 "symptom" がありません/);
  assert.match(r.stderr, /使い方: context-grill run bug-triage symptom=<値> \[component=<値>\]/);
  assert.equal(runCount(proj), before);
  const r2 = cli(proj, ['run', 'bug-triage', 'symptom=', '--dry-run']);
  assertFails(r2, /必須の引数 "symptom" が空です/);
});

test('E4: 同じ引数名を 2 回指定するとエラー', async () => {
  const proj = await shared();
  const before = runCount(proj);
  const r = cli(proj, ['run', 'bug-triage', 'symptom=a', 'symptom=b', '--dry-run']);
  assertFails(r, /引数 "symptom" が 2 回指定されています/);
  assert.equal(runCount(proj), before);
});

test('E5: = の無い語・名前が空の語はエラー', async () => {
  const proj = await shared();
  const before = runCount(proj);
  for (const word of ['タイムアウト', '=x']) {
    const r = cli(proj, ['run', 'bug-triage', word, '--dry-run']);
    assertFails(r, /名前=値/);
  }
  assert.equal(runCount(proj), before);
});

test('E6: 宣言されていない引数名（__proto__ を含む）はエラー', async () => {
  const proj = await shared();
  const before = runCount(proj);
  assertFails(cli(proj, ['run', 'bug-triage', 'symptom=s', 'fokus=x', '--dry-run']), /引数 "fokus" は宣言されていません/);
  assertFails(cli(proj, ['run', 'bug-triage', 'symptom=s', '__proto__=x', '--dry-run']), /引数 "__proto__"/);
  assert.equal(runCount(proj), before);
});

test('E7: --task / --effort / --source / --sources は常にエラー（空値・否定形も含む）', async () => {
  const proj = await shared();
  const before = runCount(proj);
  const cases = [
    ['--task', 'bug'], ['-t', 'bug'], ['--effort', 'deep'], ['-e', 'deep'],
    ['--source', 'api'], ['--source='], ['--no-source'], ['--sources', 'api'],
  ];
  for (const extra of cases) {
    const r = cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', ...extra]);
    assertFails(r, /run では --(task|effort|source|sources) は指定できません/);
  }
  assert.equal(runCount(proj), before);
});

test('E8: 未知のフラグはエラー。引数名の形なら focus=値 のヒントが付く', async () => {
  const proj = await shared();
  const before = runCount(proj);
  const f = cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '--focus', 'x']);
  assertFails(f, /使えないオプション: --focus/);
  assert.match(f.stderr, /focus=値/);
  assertFails(cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '--arg', 'symptom=x']), /使えないオプション: --arg/);
  // --top は引数名ではないので、引数名の形のヒントは付けない。-k は alias 経由で --top と表示する
  const top = cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '--top', '3']);
  assertFails(top, /使えないオプション: --top（-k）/);
  assert.doesNotMatch(top.stderr, /top=値/);
  const k = cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '-k', '3']);
  assertFails(k, /使えないオプション: --top（-k）/);
  assert.doesNotMatch(k.stderr, /top=値/);
  assert.equal(runCount(proj), before);
});

test('E9: --model / --out の値なし、引数を吸い込んだ値はエラー', async () => {
  const proj = await shared();
  const before = runCount(proj);
  assertFails(cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '--model']), /値が必要/);
  assertFails(cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '--out']), /値が必要/);
  for (const f of ['--out=', '--no-out', '--model=', '--no-model']) {
    assertFails(cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', f]), /値が必要/);
  }
  assertFails(cli(proj, ['run', 'bug-triage', '--dry-run', '--model', 'symptom=x']), /引数のように見えます/);
  assertFails(cli(proj, ['run', 'bug-triage', '--dry-run', '--out', 'symptom=x']), /引数のように見えます/);
  assertFails(cli(proj, ['run', 'bug-triage', '--dry-run', '--log', 'component=x', 'symptom=s']), /引数のように見えます/);
  assert.equal(runCount(proj), before);
  // 宣言されていない名前の値は誤検知しない（ファイル名の a=b.md など）
  const ok = cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '--out', path.join(proj.dir, 'k=v.md')]);
  assert.equal(ok.status, 0, ok.stderr);
});

test('E10: 不正な preset が混在しても、正常な preset は使える', () => withProject({
  presets: [BUG_TRIAGE, { name: 'broken', task: 'bug', model: 'x', instruction: 'y' }],
}, async (proj) => {
  assertFails(cli(proj, ['run', 'broken', '--dry-run']), /定義が不正/);
  assert.equal(runCount(proj), 0);
  const ok = cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run']);
  assert.equal(ok.status, 0, ok.stderr);
}));

test('E11: presets がオブジェクト形式なら配列で書くよう案内して終了 1', () => withProject({ presets: { a: { name: 'x' } } }, async (proj) => {
  assertFails(cli(proj, ['run', 'x', '--dry-run']), /配列/);
  assert.equal(runCount(proj), 0);
  // 名前なしでも、定義済みなしと言うだけでなく不正な定義があることを案内する
  const noName = cli(proj, ['run']);
  assertFails(noName, /preset 名を指定/);
  assert.match(noName.stderr, /設定の presets に不正な定義があります（context-grill doctor で確認できます）/);
  assert.equal(runCount(proj), 0);
}));

test('E12: 任意引数だけの preset で値を渡さないと指示文が空でエラー', async () => {
  const proj = await shared();
  const before = runCount(proj);
  const r = cli(proj, ['run', 'opt-only', '--dry-run']);
  assertFails(r, /指示文が空/);
  assert.match(r.stderr, /使い方: context-grill run opt-only \[opt=<値>\]/);
  assert.equal(runCount(proj), before);
});

// ============================================================ 安全ゲート（実際の通信は起こさない）
test('S1: provider dry なら --dry-run なしでも bundle が出て、通信は起きない', async () => {
  const proj = await shared();
  const r = cli(proj, ['run', 'no-args']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<evidence id="E1"/);
  assert.ok(!fs.existsSync(egressLog(proj)));
});

test('S2: allowLlmUpload=false なら --dry-run なしはブロックされ、--dry-run は通る（dryRun が届いている）', () =>
  withProject({ llm: ANTHROPIC, security: { allowLlmUpload: false }, presets: [NO_ARGS] }, async (proj) => {
    const blocked = cli(proj, ['run', 'no-args']);
    assertFails(blocked, /allowLlmUpload=false/);
    assert.ok(!fs.existsSync(egressLog(proj)));
    const dry = cli(proj, ['run', 'no-args', '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /<evidence id="E1"/);
    assert.ok(!fs.existsSync(egressLog(proj)));
  }));

test('S3: --offline は run でも効く', () =>
  withProject({ llm: ANTHROPIC, security: { allowLlmUpload: true }, presets: [NO_ARGS] }, async (proj) => {
    const env = { CG_RUN_TEST_LLM_KEY: 'dummy' };
    assertFails(cli(proj, ['run', 'no-args', '--offline'], { env }), /オフラインモード/);
    const dry = cli(proj, ['run', 'no-args', '--offline', '--dry-run'], { env });
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(!fs.existsSync(egressLog(proj)));
  }));

test('S4: --model は modelOverride として runTask に届く', () =>
  withProject({ llm: ANTHROPIC, security: { allowLlmUpload: false }, presets: [NO_ARGS] }, async (proj) => {
    const out = json(cli(proj, ['run', 'no-args', '--model', 'x', '--dry-run', '--json']));
    assert.equal(out.meta.model, 'x');
    const none = json(cli(proj, ['run', 'no-args', '--dry-run', '--json']));
    assert.equal(none.meta.model, 'm');
  }));

// ============================================================ presets コマンド
test('L1: presets は使える preset を説明つきで表示する（索引なしでも動く）', () => withProject({ presets: [BUG_TRIAGE, NO_ARGS], noIndex: true }, async (proj) => {
  const r = cli(proj, ['presets']);
  assert.equal(r.status, 0, r.stderr);
  for (const s of [
    'bug-triage', '障害の原因調査', 'task=bug', 'effort=deep', 'sources=api',
    'symptom（必須）症状', 'component（任意、既定 "エラー処理"）対象',
    '指示: {{symptom}} の原因を調べて',
    'context-grill run bug-triage symptom=<値> [component=<値>]',
    'no-args', 'sources=全て',
  ]) assert.ok(r.stdout.includes(s), `出力に "${s}" がありません:\n${r.stdout}`);
}));

test('L2: presets --json は {presets, errors} で、presets は listPresets と同じ形', () => withProject({ presets: [BUG_TRIAGE, NO_ARGS], noIndex: true }, async (proj) => {
  const config = await loadConfig(proj.file);
  const out = json(cli(proj, ['presets', '--json']));
  assert.deepEqual(out, { presets: listPresets(config), errors: [] });
}));

test('L3: 不正な定義が混在すると、正常なものは表示しつつ終了 1', () => withProject({
  presets: [BUG_TRIAGE, { name: 'broken', task: 'bug', model: 'x', instruction: 'y' }], noIndex: true,
}, async (proj) => {
  const text = cli(proj, ['presets']);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /bug-triage/);
  assert.match(text.stderr, /使えない preset の定義があります/);
  assert.match(text.stderr, /presets\[1\]/);
  assert.doesNotMatch(text.stderr, /未知のコマンド/);
  const j = cli(proj, ['presets', '--json']);
  assert.equal(j.status, 1);
  const out = JSON.parse(j.stdout);
  assert.deepEqual(out.presets.map((p) => p.name), ['bug-triage']);
  assert.ok(out.errors.some((e) => e.includes('presets[1]')));
}));

test('L4: preset が 0 件なら案内を出して終了 0', async () => {
  for (const presets of [undefined, []]) {
    await withProject({ presets, noIndex: true }, async (proj) => {
      const r = cli(proj, ['presets']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout + r.stderr, /preset は定義されていません/);
      assert.doesNotMatch(r.stderr, /未知のコマンド/);
      assert.deepEqual(json(cli(proj, ['presets', '--json'])), { presets: [], errors: [] });
    });
  }
});

// ============================================================ HELP / ドキュメント
test('H1: --help に run と presets が載る', () => withProject({ noIndex: true }, async (proj) => {
  const r = cli(proj, ['--help']);
  assert.match(r.stdout, /run <名前>/);
  assert.match(r.stdout, /^ {2}presets /m);
}));

test('X1: 設定例の presets は検証を通り、全件を解決できる', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-presets-example-'));
  try {
    const file = path.join(dir, 'context-grill.config.json');
    await fsp.copyFile(path.join(ROOT, 'context-grill.config.example.json'), file);
    const config = await loadConfig(file);
    const presets = listPresets(config);
    assert.ok(presets.length >= 2, `設定例の preset が ${presets.length} 件しかありません`);
    assert.deepEqual(validatePresets(config), []);
    for (const p of presets) {
      const args = Object.fromEntries(p.arguments.filter((a) => a.required).map((a) => [a.name, 'x']));
      assert.ok(resolvePreset(config, p.name, args).instruction.length > 0, p.name);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('X2: main の switch の全コマンドが HELP と commands.md のコマンド一覧にある', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  const start = src.indexOf('switch (cmd)');
  assert.ok(start >= 0, 'main の switch (cmd) が見つかりません');
  const rest = src.slice(start);
  const body = rest.slice(0, rest.search(/^\s*default\s*:/m))
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'); // コメントは除く
  const cmds = [...body.matchAll(/\bcase\s+(['"`])([a-z][a-z0-9-]*)\1\s*:/g)].map((m) => m[2]);
  assert.ok(cmds.length >= 12, `switch から取り出せたコマンドが少なすぎます: ${cmds}`);
  for (const c of ['init', 'ask', 'run', 'presets']) assert.ok(cmds.includes(c), `switch に ${c} がありません`);

  const proj = await shared();
  const help = cli(proj, ['--help']).stdout;
  const md = fs.readFileSync(path.join(ROOT, 'commands.md'), 'utf8');
  const s = md.indexOf('## コマンド一覧');
  assert.ok(s >= 0, 'commands.md に「## コマンド一覧」がありません');
  const doc = md.slice(s, md.indexOf('\n---', s)); // 一覧の表だけを見る（タスク表などに当たらないように）
  for (const c of cmds) {
    assert.match(help, new RegExp(`^ {2}${c}(\\s|$)`, 'm'), `HELP に ${c} がありません`);
    assert.match(doc, new RegExp(`^\\| \`${c}[ \`]`, 'm'), `commands.md のコマンド一覧に ${c} がありません`);
  }
  // 逆方向: 文書にあるのに switch に無いコマンド
  const listed = [...doc.matchAll(/^\| `([a-z][a-z0-9-]*)[ `]/gm)].map((m) => m[1]);
  assert.ok(listed.length >= 12, `commands.md の一覧から取り出せたコマンドが少なすぎます: ${listed}`);
  for (const c of listed) assert.ok(cmds.includes(c), `commands.md の一覧にあるが switch に無い: ${c}`);
});
