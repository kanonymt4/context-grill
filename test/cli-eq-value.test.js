import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `--フラグ=値` の値に `=` が含まれるとき、最初の `=` だけで分割されること。
// 以前は split('=') で 2 つ目以降が黙って捨てられ、`--config=a=b.json` が `a` を読んでいた。
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
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-eq-value-'));
  // 正しい側（名前に = を含む）と囮（= の手前だけの名前）
  await fsp.writeFile(path.join(tmp, 'a=b.json'), JSON.stringify({ project: 'RIGHT', sources: [] }));
  await fsp.writeFile(path.join(tmp, 'a'), JSON.stringify({ project: 'WRONG', sources: [] }));
  const r = run(['sync', '-c', 'a=b.json']);
  assert.equal(r.status, 0, `sync に失敗: ${r.stderr}`);
});

after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('--config=a=b.json は = を含む名前の設定を読む（囮の a を読まない）', () => {
  const r = run(['status', '--config=a=b.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('プロジェクト: RIGHT'), r.stdout);
  assert.ok(!r.stdout.includes('WRONG'), r.stdout);
});

test('--out=r=1.json はその名前のファイルに書く', async () => {
  const r = run(['scan', '--out=r=1.json', '-c', 'a=b.json']);
  assert.equal(r.status, 0, r.stderr);
  await fsp.access(path.join(tmp, 'r=1.json'));
  await assert.rejects(fsp.access(path.join(tmp, 'r')));
});

test('--top=5=6 は値が 5=6 として数値検査でエラーになる', () => {
  const r = run(['search', 'x', '--top=5=6', '-c', 'a=b.json']);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes('--top は 1 以上の整数'), r.stderr);
  assert.ok(r.stderr.includes('5=6'), r.stderr);
});

test('対照: --top=5 は従来どおり通る', () => {
  const r = run(['search', 'x', '--top=5', '-c', 'a=b.json']);
  assert.equal(r.status, 0, r.stderr);
});
