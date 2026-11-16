import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 真偽フラグ（BOOL_FLAGS）に `=値` が付いたときの扱い。
// `--force=false` が文字列 "false"（真）になり、逆の意味で効いていた問題の回帰テスト。
// 子プロセスで CLI を実行し、一時ディレクトリの設定を -c で渡す（リポジトリ直下の .env を読ませない）。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'context-grill.js');
const KEY_ENV = 'CG_BOOL_FLAG_TEST_KEY';

let tmp;
let cfg;          // 埋め込みなし
let cfgEmbed;     // 埋め込みあり（送信先はダミーサーバー）
let server;
let embedRequests = 0;

function run(args, { cwd = tmp } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, [KEY_ENV]: 'dummy-not-a-real-key' };
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CONTEXT_GRILL_LOG_LEVEL']) delete env[k];
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-boolflag-'));
  await fsp.mkdir(path.join(tmp, 'proj'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'proj', 'handler.js'), 'export function handler() { return "timeout-retry"; }\n');

  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      embedRequests++;
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')).input;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const sources = [{ id: 'proj', type: 'local', path: 'proj', include: ['**/*'], includeUnknownTypes: true }];
  cfg = path.join(tmp, 'cfg.json');
  await fsp.writeFile(cfg, JSON.stringify({ project: 'x', sources, llm: { provider: 'dry', model: 'd' } }));
  cfgEmbed = path.join(tmp, 'cfg-embed.json');
  await fsp.writeFile(cfgEmbed, JSON.stringify({
    project: 'x', sources, llm: { provider: 'dry', model: 'd' },
    retrieval: { embedding: { provider: 'openai-compat', model: 'm', dimensions: 4, baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: KEY_ENV } },
    security: { allowEmbeddingUpload: true },
  }));
  const r = await run(['-c', cfg, 'sync']);
  assert.equal(r.status, 0, `sync に失敗: ${r.stderr}`);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** init の対象ディレクトリ（既存の設定 project: keepme を置く） */
async function initDir() {
  const dir = await fsp.mkdtemp(path.join(tmp, 'init-'));
  await fsp.writeFile(path.join(dir, 'context-grill.config.json'), JSON.stringify({ project: 'keepme', sources: [] }));
  return dir;
}
const projectOf = async (dir) => JSON.parse(await fsp.readFile(path.join(dir, 'context-grill.config.json'), 'utf8')).project;

// ------------------------------------------------- 直すべき入力
test('init --force=false は既存の設定を上書きしない', async () => {
  const dir = await initDir();
  const r = await run(['init', '--dir', dir, '--force=false', '-c', cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await projectOf(dir), 'keepme');
});

test('init --force=true は既存の設定を上書きする', async () => {
  const dir = await initDir();
  const r = await run(['init', '--dir', dir, '--force=true', '-c', cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(await projectOf(dir), 'keepme');
});

test('init --force（値なし）は従来どおり上書きする', async () => {
  const dir = await initDir();
  const r = await run(['init', '--dir', dir, '--force', '-c', cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(await projectOf(dir), 'keepme');
});

test('init --force=abc はエラーで、設定に触れない', async () => {
  const dir = await initDir();
  const r = await run(['init', '--dir', dir, '--force=abc', '-c', cfg]);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes('--force は値を取りません'), r.stderr);
  assert.equal(await projectOf(dir), 'keepme');
});

test('--force= （空の値）もエラー', async () => {
  const dir = await initDir();
  const r = await run(['init', '--dir', dir, '--force=', '-c', cfg]);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes('--force は値を取りません'), r.stderr);
});

test('--force=true=x のように後ろが続く値もエラー', async () => {
  const dir = await initDir();
  const r = await run(['init', '--dir', dir, '--force=true=x', '-c', cfg]);
  assert.equal(r.status, 1, r.stdout);
  assert.equal(await projectOf(dir), 'keepme');
});

test('search --raw=false は墨消しを保つ（--raw の警告が出ない）', async () => {
  const r = await run(['search', 'timeout', '--raw=false', '-c', cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes('墨消しを無効化'), r.stderr);
});

test('search --raw=true は墨消しを無効化する（対照）', async () => {
  const r = await run(['search', 'timeout', '--raw=true', '-c', cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes('墨消しを無効化'), r.stderr);
});

test('--json=false は JSON で出力しない', async () => {
  const r = await run(['status', '--json=false', '-c', cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.throws(() => JSON.parse(r.stdout));
});

test('--json=true は JSON で出力する（対照）', async () => {
  const r = await run(['status', '--json=true', '-c', cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test('--json=maybe はエラー', async () => {
  const r = await run(['status', '--json=maybe', '-c', cfg]);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes('--json は値を取りません'), r.stderr);
});

test('sync --embed=false は埋め込み API を呼ばない', async () => {
  embedRequests = 0;
  const r = await run(['sync', '--full', '--embed=false', '-c', cfgEmbed]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(embedRequests, 0, '埋め込み API にリクエストが届いた');
});

test('sync --embed=abc はエラーで、埋め込み API も呼ばない', async () => {
  embedRequests = 0;
  const r = await run(['sync', '--full', '--embed=abc', '-c', cfgEmbed]);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes('--embed は値を取りません'), r.stderr);
  assert.equal(embedRequests, 0);
});

test('--no-embed=x（否定形に値）はエラー', async () => {
  const r = await run(['sync', '--no-embed=x', '-c', cfgEmbed]);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes('--embed は値を取りません'), r.stderr);
});

// ------------------------------------------------- 変わってはいけない入力（対照）
test('sync --embed=true は埋め込み API を呼ぶ（対照。ベクトルはキャッシュされるので 1 回だけ確認する）', async () => {
  embedRequests = 0;
  const r = await run(['sync', '--full', '--embed=true', '-c', cfgEmbed]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(embedRequests > 0, '埋め込み API が呼ばれなかった');
});

test('sync --no-embed は従来どおり埋め込み API を呼ばない', async () => {
  embedRequests = 0;
  const r = await run(['sync', '--full', '--no-embed', '-c', cfgEmbed]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(embedRequests, 0);
});

test('--offline は先頭のグローバルオプションとして search の語を消費しない', async () => {
  const r = await run(['--offline', 'search', 'timeout', '-c', cfg]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('handler.js'), r.stdout);
});

test('ask --dry-run（値なし）は従来どおり動く', async () => {
  const r = await run(['ask', '「timeout」を調べて', '--dry-run', '-c', cfg]);
  assert.equal(r.status, 0, r.stderr);
});

test('--help は値付きの真偽フラグより先に処理される', async () => {
  const r = await run(['init', '--force=abc', '--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('使い方:'), r.stdout);
});
