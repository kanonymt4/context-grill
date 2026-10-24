import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { syncSources } from '../src/index/ingest.js';
import { initEgress } from '../src/util/egress.js';
import { syncGithub } from '../src/connectors/github.js';

// コネクタが黙って捨てたファイルの報告と、GitHub の issues / pulls の limit の分離。
// 外部通信は 127.0.0.1 のダミー API だけ。

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseConfig(root, sources) {
  return {
    rootDir: root,
    workspaceDir: path.join(root, 'ws'),
    sources,
    llm: { provider: 'dry' },
    retrieval: { embedding: { provider: 'none' } },
    security: { networkMode: 'normal', auditLog: false },
  };
}

/** fn の間に stderr へ出た文字列を集める */
async function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk, ...rest) => { out += String(chunk); return true; };
  try { await fn(); } finally { process.stderr.write = orig; }
  return out;
}

function writeSkipFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(dir, 'style.css'), 'a{}');
  fs.writeFileSync(path.join(dir, 'data.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT');
  fs.writeFileSync(path.join(dir, 'big.md'), 'x'.repeat(500_000));
  fs.writeFileSync(path.join(dir, 'ok.md'), '# ok\n');
  fs.writeFileSync(path.join(dir, 'bin.md'), Buffer.from([0x61, 0x00, 0x62]));
  fs.writeFileSync(path.join(dir, 'blob.dat'), Buffer.from([0x00, 0x01, 0x02]));
}

const EXPECTED = { unknownType: 4, tooLarge: 1, binary: 2 };
const LINE = '種別不明で除外 4 件 / サイズ超過 1 件 / バイナリ 2 件';

test('local: 取り込まなかったファイルの理由別の件数を state.skipped に残し、sync の出力に出す', async () => {
  const root = tmpDir('cg-skip-local-');
  try {
    writeSkipFixture(path.join(root, 'docs'));
    const config = baseConfig(root, [{ id: 'docs', type: 'local', path: 'docs' }]);
    let report;
    const err = await captureStderr(async () => { report = await syncSources(config, {}); });
    assert.equal(report[0].ok, true);
    assert.equal(report[0].documents, 1);
    assert.deepEqual(report[0].state.skipped, EXPECTED);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'ws', 'cache', 'sources', 'docs', 'state.json'), 'utf8'));
    assert.deepEqual(saved.skipped, EXPECTED);
    assert.equal(saved.count, 1);   // 既存のキーを壊さない
    assert.ok(err.includes(`  docs: 1 ドキュメント（${LINE}）`), `出力: ${err}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('local: 全部取り込まれるなら除外の内訳は出さない', async () => {
  const root = tmpDir('cg-skip-none-');
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'ok.md'), '# ok\n');
    const config = baseConfig(root, [{ id: 'docs', type: 'local', path: 'docs' }]);
    let report;
    const err = await captureStderr(async () => { report = await syncSources(config, {}); });
    assert.deepEqual(report[0].state.skipped, { unknownType: 0, tooLarge: 0, binary: 0 });
    assert.ok(err.includes('  docs: 1 ドキュメント'), `出力: ${err}`);
    assert.ok(!err.includes('除外'), `出力: ${err}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('local: 0 の理由は省略する', async () => {
  const root = tmpDir('cg-skip-part-');
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'ok.md'), '# ok\n');
    fs.writeFileSync(path.join(root, 'docs', 'a.csv'), 'a');
    const config = baseConfig(root, [{ id: 'docs', type: 'local', path: 'docs' }]);
    const err = await captureStderr(async () => { await syncSources(config, {}); });
    assert.ok(err.includes('  docs: 1 ドキュメント（種別不明で除外 1 件）'), `出力: ${err}`);
    assert.ok(!err.includes('サイズ超過') && !err.includes('バイナリ'), `出力: ${err}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('github(clone, 作業ディレクトリ参照): 同じ理由別の件数を state.skipped に残す', async () => {
  const root = tmpDir('cg-skip-gh-');
  try {
    writeSkipFixture(path.join(root, 'repo'));
    const config = baseConfig(root, [{ id: 'gh', type: 'github', path: path.join(root, 'repo') }]);
    initEgress(config);
    const { docs, state } = await syncGithub(config.sources[0], { config, paths: { repos: path.join(root, 'repos') } });
    assert.equal(docs.length, 1);
    assert.deepEqual(state.skipped, EXPECTED);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- issues / pulls ----

/** /issues（PR を混ぜる）と /pulls を返すダミー API。受けたクエリを記録する。 */
async function startApi() {
  const calls = [];
  const mk = (n, extra = {}) => ({
    number: n, title: `t${n}`, state: 'open', body: `body${n}`, user: { login: 'u' },
    created_at: '2026-01-01T00:00:00Z', updated_at: `2026-01-${String(30 - n).padStart(2, '0')}T00:00:00Z`,
    labels: [], html_url: `http://example.invalid/${n}`, ...extra,
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push({ path: u.pathname, state: u.searchParams.get('state'), page: u.searchParams.get('page') });
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/repos/o/r/commits/HEAD') return json({ sha: 'abc' });
    if (u.pathname.startsWith('/repos/o/r/git/trees/')) return json({ tree: [] });
    if (u.pathname === '/repos/o/r/issues') {
      // 新しい順に 10 件。PR（番号 101〜105）が先頭側に混ざる
      const items = [];
      for (let i = 1; i <= 5; i++) items.push(mk(100 + i, { pull_request: { url: 'x' } }));
      for (let i = 1; i <= 5; i++) items.push(mk(i));
      return json(items);
    }
    if (u.pathname === '/repos/o/r/pulls') {
      const items = [];
      for (let i = 1; i <= 6; i++) items.push(mk(200 + i, { pull_request: { url: 'x' } }));
      return json(items);
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function runApi(extra) {
  const api = await startApi();
  const root = tmpDir('cg-skip-api-');
  try {
    const src = { id: 'gh', type: 'github', repo: 'o/r', mode: 'api', apiBaseUrl: api.baseUrl, ...extra };
    const config = baseConfig(root, [src]);
    initEgress(config);
    const { docs } = await syncGithub(src, { config, paths: { repos: path.join(root, 'repos') } });
    return { docs, calls: api.calls };
  } finally { await api.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

const nums = (docs, kind) => docs.filter((d) => d.kind === kind).map((d) => d.meta.number);

test('github: issues.limit と pulls.limit を別々に守る', async () => {
  const { docs } = await runApi({ issues: { enabled: true, limit: 3 }, pulls: { enabled: true, limit: 2 } });
  assert.deepEqual(nums(docs, 'issue'), [1, 2, 3]);       // PR（101〜）は含めず、issues だけで 3 件
  assert.deepEqual(nums(docs, 'pr'), [201, 202]);         // /pulls から 2 件
});

test('github: pulls だけ有効なら pulls.limit ぶん取得する', async () => {
  const { docs } = await runApi({ pulls: { enabled: true, limit: 4 } });
  assert.equal(nums(docs, 'issue').length, 0);
  assert.deepEqual(nums(docs, 'pr'), [201, 202, 203, 204]);
});

test('github: issues だけ有効なら issues.limit ぶん取得する（PR は除く）', async () => {
  const { docs } = await runApi({ issues: { enabled: true, limit: 4 } });
  assert.deepEqual(nums(docs, 'issue'), [1, 2, 3, 4]);
  assert.equal(nums(docs, 'pr').length, 0);
});

test('github: state は issues / pulls それぞれの値を使う', async () => {
  const { calls } = await runApi({ issues: { enabled: true, limit: 2, state: 'open' }, pulls: { enabled: true, limit: 2, state: 'closed' } });
  assert.equal(calls.find((c) => c.path === '/repos/o/r/issues').state, 'open');
  assert.equal(calls.find((c) => c.path === '/repos/o/r/pulls').state, 'closed');
});
