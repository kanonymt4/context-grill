import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// offline の使い勝手: doctor / privacy の表示と、sync の「外部通信: N 回」

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'context-grill.js');

/** 子プロセスの環境。リポジトリ直下の .env は cwd と -c で避け、キー類は消す */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CONTEXT_GRILL_LOG_LEVEL', 'CG_UX_EMBED_KEY']) delete env[k];
  return { ...env, ...extra };
}

async function makeProject(body) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-offline-ux-'));
  await fsp.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'docs', 'guide.md'), '# guide\n\ntimeout retry の方針\n');
  const file = path.join(dir, 'context-grill.config.json');
  await fsp.writeFile(file, JSON.stringify({
    project: 'x',
    sources: [{ id: 'docs', type: 'local', path: 'docs', include: ['**/*'], includeUnknownTypes: true }],
    llm: { provider: 'dry', model: 'd' },
    ...body,
  }));
  return { dir, file };
}

function runCli(dir, file, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '-c', file], { cwd: dir, env: cleanEnv(env), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** 非同期で実行する（同一プロセス内のダミーサーバーが応答できるようにするため） */
function runCliAsync(dir, file, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '-c', file], { cwd: dir, env: cleanEnv(env) });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('タイムアウト')); }, 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// ---------------------------------------------------------------- doctor
test('doctor: --offline がネットワークモードに反映される', async () => {
  // 通信を許可するホストが出るソース（github）を足しておく。offline ではそれを並べてはいけない
  const { dir, file } = await makeProject({
    sources: [
      { id: 'docs', type: 'local', path: 'docs', include: ['**/*'], includeUnknownTypes: true },
      { id: 'gh', type: 'github', repo: 'your-org/your-repo' },
    ],
  });
  const r = runCli(dir, file, ['--offline', 'doctor']);
  const line = r.out.split('\n').find((l) => l.includes('ネットワークモード'));
  assert.ok(line, `ネットワークモードの行が無い:\n${r.out}`);
  assert.match(line, /offline/);
  assert.match(line, /^✓/);
  assert.doesNotMatch(r.out, /github\.com/, 'offline では送信許可ホストを並べない');
  assert.match(r.out, /送信許可ホスト\s+なし/);
});

test('doctor: 設定が normal なら normal と表示する', async () => {
  const { dir, file } = await makeProject({});
  const line = runCli(dir, file, ['doctor']).out.split('\n').find((l) => l.includes('ネットワークモード'));
  assert.ok(line, 'ネットワークモードの行が無い');
  assert.match(line, /normal/);
  assert.doesNotMatch(line, /offline/);
});

test('doctor: 設定ファイルの networkMode=offline も反映される（--offline なし）', async () => {
  const { dir, file } = await makeProject({ security: { networkMode: 'offline' } });
  const line = runCli(dir, file, ['doctor']).out.split('\n').find((l) => l.includes('ネットワークモード'));
  assert.match(line ?? '', /offline/);
});

// ---------------------------------------------------------------- privacy
test('privacy: --offline では「現在はすべて拒否」と示し、「送信あり」を出さない', async () => {
  const { dir, file } = await makeProject({});
  const r = runCli(dir, file, ['--offline', 'privacy']);
  assert.equal(r.code, 0);
  assert.match(r.out, /offline のため現在はすべて拒否/);
  assert.doesNotMatch(r.out, /送信あり/);
  assert.match(r.out, /送信なし（offline）/);
});

test('privacy: normal の出力は従来どおり（回帰ガード）', async () => {
  const { dir, file } = await makeProject({});
  const r = runCli(dir, file, ['privacy']);
  assert.equal(r.code, 0);
  assert.match(r.out, /■ 送信が許可されているホスト（これ以外へは送信不可）\n/);
  assert.match(r.out, /送信あり {2}ソース取得/);
  assert.match(r.out, /送信なし {2}埋め込み API/);
  assert.doesNotMatch(r.out, /offline のため/);
  assert.doesNotMatch(r.out, /（offline）/);
});

// ---------------------------------------------------------------- sync の外部通信回数
test('sync: 「外部通信: N 回」に埋め込みの通信が含まれ、egress.log の行数と一致する', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { input } = JSON.parse(body);
      const data = input.map((_, i) => ({ index: i, embedding: [1, 0, 0, 0] }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const { dir, file } = await makeProject({
      retrieval: { embedding: { provider: 'openai-compat', model: 'm', dimensions: 4, baseUrl, apiKeyEnv: 'CG_UX_EMBED_KEY', batch: 96 } },
      security: { allowEmbeddingUpload: true },
    });
    const r = await runCliAsync(dir, file, ['sync'], { CG_UX_EMBED_KEY: 'dummy' });
    assert.equal(r.code, 0, r.err);
    const lines = (await fsp.readFile(path.join(dir, '.context-grill', 'egress.log'), 'utf8')).split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, '埋め込みの通信が egress.log に残っていること（前提）');
    const m = r.err.match(/外部通信: (\d+) 回/g) || [];
    assert.equal(m.length, 1, `「外部通信」の行がちょうど 1 回出ること:\n${r.err}`);
    assert.equal(Number(m[0].match(/\d+/)[0]), lines.length, `回数が egress.log の行数と一致すること:\n${r.err}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
