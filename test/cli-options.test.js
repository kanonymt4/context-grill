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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'context-grill.js');

// ---------------------------------------------------------------- 共通準備
const SOURCES = [
  { id: 'repo', type: 'local', path: 'repo', include: ['**/*'], includeUnknownTypes: true },
  { id: 'docs', type: 'local', path: 'docs', include: ['**/*'], includeUnknownTypes: true },
];

const PRESET = {
  name: 'bug-triage', task: 'bug', effort: 'normal',
  instruction: '{{symptom}} の原因を調べて。「timeout」「retry」を見たい',
  arguments: [{ name: 'symptom' }],
};

/** 一時ディレクトリに local ソース repo / docs と設定を置き、同一プロセス内で索引まで作る */
async function makeProject() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-cli-options-'));
  await fsp.mkdir(path.join(dir, 'repo'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'docs', 'guide.md'), '# guide\n\ntimeout retry の方針: docs-timeout-retry\n');
  await fsp.writeFile(path.join(dir, 'repo', 'handler.js'),
    'export function handler(x) { /* timeout retry */ return eval(x); }\n');
  const file = path.join(dir, 'context-grill.config.json');
  await fsp.writeFile(file, JSON.stringify({
    project: 'x',
    sources: SOURCES,
    llm: { provider: 'dry', model: 'd' },
    presets: [PRESET],
  }));
  const config = await loadConfig(file);
  await syncSources(config, {});
  await buildIndex(config, { embed: false });
  return { dir, file };
}

/** リポジトリ直下の .env は cwd と -c で避け、キー類は消す */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CONTEXT_GRILL_LOG_LEVEL']) delete env[k];
  return env;
}

/** -c は先頭に置く（`--` より後ろに回ると位置引数として扱われてしまうため） */
function cli(proj, args) {
  const r = spawnSync(process.execPath, [CLI, '-c', proj.file, ...args], {
    cwd: proj.dir, encoding: 'utf8', env: cleanEnv(),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** -c を自動では付けない実行（-c 自体の検査用） */
function cliRaw(proj, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: proj.dir, encoding: 'utf8', env: cleanEnv() });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function withProject(fn) {
  const proj = await makeProject();
  try {
    return await fn(proj);
  } finally {
    await fsp.rm(proj.dir, { recursive: true, force: true });
  }
}

/** 失敗を想定する実行の確認。「未知のコマンド」で落ちているだけの空振りを防ぐ */
function assertFails(r, re) {
  assert.equal(r.status, 1, `終了コード: ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, re);
  assert.doesNotMatch(r.stderr, /未知のコマンド/);
}

const noStray = (proj) => assert.equal(fs.existsSync(path.join(proj.dir, 'true')), false, '"true" というファイルができている');

// ------------------------------------------------- 値を取るフラグの値なし
const MISSING = [
  // [説明, コマンド, 追加する引数]
  ['ask --out', ['ask', 'x', '--dry-run'], ['--out']],
  ['ask --out=', ['ask', 'x', '--dry-run'], ['--out=']],
  ['ask --no-out', ['ask', 'x', '--dry-run'], ['--no-out']],
  ['scan --out', ['scan'], ['--out']],
  ['scan --out=', ['scan'], ['--out=']],
  ['scan --no-out', ['scan'], ['--no-out']],
  ['ask --model', ['ask', 'x', '--dry-run'], ['--model']],
  ['ask --model=', ['ask', 'x', '--dry-run'], ['--model=']],
  ['ask --effort', ['ask', 'x', '--dry-run'], ['--effort']],
  ['ask --task', ['ask', 'x', '--dry-run'], ['--task']],
  ['ask --source', ['ask', 'x', '--dry-run'], ['--source']],
  ['search --source', ['search', 'q'], ['--source']],
  ['search --source=', ['search', 'q'], ['--source=']],
  ['search --no-source', ['search', 'q'], ['--no-source']],
  ['search --source (空文字)', ['search', 'q'], ['--source', '']],
  ['scan --source=', ['scan'], ['--source=']],
  ['sync --source=', ['sync'], ['--source=']],
  ['search --log', ['search', 'q'], ['--log']],
  ['search -k', ['search', 'q'], ['-k']],
  ['search --top=', ['search', 'q'], ['--top=']],
  ['scan --severity', ['scan'], ['--severity']],
  ['scan --severity=', ['scan'], ['--severity=']],
];

for (const [name, base, extra] of MISSING) {
  test(`値なし: ${name} は「値が必要」で終了コード 1（"true" ファイルを作らない）`, async () => {
    await withProject(async (proj) => {
      assertFails(cli(proj, [...base, ...extra]), /値が必要/);
      noStray(proj);
    });
  });
}

test('値なし: -c（値なし）は TypeError でなく「値が必要」', async () => {
  await withProject(async (proj) => {
    const r = cliRaw(proj, ['search', 'q', '-c']);
    assertFails(r, /値が必要/);
    assert.doesNotMatch(r.stderr, /TypeError/);
  });
});

test('値なし: init --dir（値なし）は「値が必要」', async () => {
  await withProject(async (proj) => {
    assertFails(cliRaw(proj, ['init', '--dir']), /値が必要/);
    assert.equal(fs.existsSync(path.join(proj.dir, 'true')), false);
  });
});

test('値なし: resolve --id（値なし）は「値が必要」', async () => {
  await withProject(async (proj) => {
    assertFails(cliRaw(proj, ['resolve', 'https://github.com/acme/api', '--id']), /値が必要/);
  });
});

// ------------------------------------------------------- run は専用の検査
test('run: --log / --config（値なし）は「値が必要」で終了コード 1', async () => {
  await withProject(async (proj) => {
    assertFails(cli(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '--log']), /--log には値が必要/);
    assertFails(cliRaw(proj, ['run', 'bug-triage', 'symptom=s', '--dry-run', '--config']), /--config には値が必要/);
  });
});

// ---------------------------------------------------------- --source の検証
test('--source: search / scan / sync は未知の id を拒否し、sync は完了を出さない', async () => {
  await withProject(async (proj) => {
    for (const args of [['search', 'q', '--source', 'nope'], ['scan', '--source', 'nope'], ['sync', '--source', 'nope'],
      ['search', 'q', '--source', 'repo,nope']]) {
      const r = cli(proj, args);
      assertFails(r, /未知のソース/);
      assert.doesNotMatch(r.stdout, /同期完了/);
    }
  });
});

test('--source: ask は --source nope を --dry-run でも拒否する', async () => {
  await withProject(async (proj) => {
    assertFails(cli(proj, ['ask', 'x', '--source', 'nope', '--dry-run']), /未知のソース/);
  });
});

// ------------------------------------------------------------- --severity
test('--severity: 不明な値は許可値の一覧つきで拒否、high は通る', async () => {
  await withProject(async (proj) => {
    const bad = cli(proj, ['scan', '--severity', 'hgih']);
    assertFails(bad, /severity/);
    assert.match(bad.stderr, /info, low, medium, high, critical/);
    assert.equal(cli(proj, ['scan', '--severity', 'high']).status, 0);
  });
});

// ------------------------------------------------------------------ -k
test('-k: 1 以上の整数以外は拒否、3 は通る', async () => {
  await withProject(async (proj) => {
    for (const v of ['abc', '0', '1.5']) assertFails(cli(proj, ['search', 'q', '-k', v]), /整数/);
    assertFails(cli(proj, ['search', 'q', '--top=abc']), /整数/);
    const ok = cli(proj, ['search', 'timeout', '-k', '3', '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(JSON.parse(ok.stdout).length <= 3);
  });
});

// -------------------------------------------------------------------- ask
test('ask: 未知のタスク（constructor を含む）と effort は索引を開く前の検証で拒否される', async () => {
  await withProject(async (proj) => {
    const t = cli(proj, ['ask', 'x', '--task', 'constructor']);
    assertFails(t, /未知のタスク/);
    assert.doesNotMatch(t.stderr, /kw\.slice/);
    assertFails(cli(proj, ['ask', 'x', '--effort', 'foo', '--dry-run']), /未知の effort/);
  });
});

// ---------------------------------------------------------------- ガード
test('ガード: 正しい指定は従来どおり通る', async () => {
  await withProject(async (proj) => {
    const out = path.join(proj.dir, 'bundle.md');
    assert.equal(cli(proj, ['ask', 'x', '--dry-run', '--out', out]).status, 0);
    assert.ok(fs.existsSync(out));

    assert.equal(cli(proj, ['search', 'timeout', '--source', 'repo', '-k', '3']).status, 0);
    assert.equal(cli(proj, ['search', 'timeout', '--source', 'repo,docs']).status, 0);

    const scanOut = path.join(proj.dir, 'scan.json');
    assert.equal(cli(proj, ['scan', '--severity', 'high', '--out', scanOut]).status, 0);
    assert.ok(fs.existsSync(scanOut));
    noStray(proj);
  });
});

test('ガード: 設定に足した独自の effort は通る', async () => {
  await withProject(async (proj) => {
    const raw = JSON.parse(await fsp.readFile(proj.file, 'utf8'));
    raw.effortPresets = { xdeep: { queries: 4, final: 10, evidenceTokens: 5000 } };
    await fsp.writeFile(proj.file, JSON.stringify(raw));
    const r = cli(proj, ['ask', 'x', '--dry-run', '--effort', 'xdeep']);
    assert.equal(r.status, 0, r.stderr);
  });
});
