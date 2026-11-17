import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ソースを設定から外して sync していない状態の status / doctor が、
// 食い違いの警告と「設定に無い」注記を出すこと。sync 直後は従来どおり。
// 子プロセスを一時ディレクトリで実行する（リポジトリ直下の .env を読ませない）。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'context-grill.js');

let tmp;

function run(args) {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CONTEXT_GRILL_LOG_LEVEL']) delete env[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: tmp, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-status-stale-'));
  const write = async (rel, body) => {
    const p = path.join(tmp, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, body);
  };
  await write('a/x.md', '# settlement notes\n\nsettlement ledger is reconciled nightly.\n');
  await write('b/y.md', '# settlement best\n\nsettlement ledger best practice.\n');
  const base = {
    project: 'stale-status',
    sources: [
      { id: 'a', type: 'local', path: 'a' },
      { id: 'b', type: 'local', path: 'b' },
    ],
    llm: { provider: 'dry', model: 'dry' },
    retrieval: { embedding: { provider: 'none' } },
  };
  await write('full.json', JSON.stringify(base));
  await write('onlya.json', JSON.stringify({ ...base, sources: [base.sources[0]] }));
  const r = run(['sync', '-c', 'full.json']);
  assert.equal(r.status, 0, `sync に失敗: ${r.stderr}`);
});

after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('対照: sync 直後の status は警告も注記も出さない', () => {
  const r = run(['status', '-c', 'full.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/変わっています/.test(r.stdout + r.stderr), r.stdout + r.stderr);
  assert.ok(!/設定に無い/.test(r.stdout), r.stdout);
  assert.ok(/^\s+a\s/m.test(r.stdout) && /^\s+b\s/m.test(r.stdout), r.stdout);
});

test('対照: sync 直後の status --json に stale / configured のキーは出ない', () => {
  const j = JSON.parse(run(['status', '--json', '-c', 'full.json']).stdout);
  assert.ok(!('stale' in j), JSON.stringify(j));
  assert.ok(!('configured' in j.sources.b), JSON.stringify(j.sources));
});

test('ソース b を設定から外すと、status は警告し、b の行に注記を付ける', () => {
  const r = run(['status', '-c', 'onlya.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /設定が索引の作成後に変わっています/);
  assert.match(r.stderr, /sync.*作り直してください/);
  assert.match(r.stderr, /MCP サーバーが常駐している場合は.*再起動/);
  const bLine = r.stdout.split('\n').find((l) => /^\s+b\s/.test(l));
  assert.ok(bLine, r.stdout);
  assert.match(bLine, /設定に無いため検索対象外/);
  const aLine = r.stdout.split('\n').find((l) => /^\s+a\s/.test(l));
  assert.ok(aLine && !/設定に無い/.test(aLine), r.stdout);
});

test('status --json は stale: true と、設定に無いソースの configured: false を持つ', () => {
  const r = run(['status', '--json', '-c', 'onlya.json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.stale, true);
  assert.equal(j.sources.b.configured, false);
  assert.ok(!('configured' in j.sources.a), JSON.stringify(j.sources.a));
});

test('doctor の索引の行が、食い違いを示す。sync 直後は示さない', () => {
  const stale = JSON.parse(run(['doctor', '--json', '-c', 'onlya.json']).stdout);
  const row = stale.find((c) => c.name === '索引');
  assert.ok(row, JSON.stringify(stale));
  assert.match(row.detail, /設定が索引の作成後に変わっています/);
  const fresh = JSON.parse(run(['doctor', '--json', '-c', 'full.json']).stdout);
  assert.ok(!/変わっています/.test(fresh.find((c) => c.name === '索引').detail));
});
