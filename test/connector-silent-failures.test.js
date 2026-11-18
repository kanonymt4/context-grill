import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { initEgress } from '../src/util/egress.js';
import { syncGithub } from '../src/connectors/github.js';
import { syncConfluence } from '../src/connectors/confluence.js';
import { httpJson } from '../src/connectors/base.js';

// コネクタの「黙って通る失敗」: ツリーの途中打ち切り、JSON でない 2xx 応答、
// 同じ next を返し続けるページネーション。外部通信は 127.0.0.1 のダミー API だけ。

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

/** ソースを持たない httpJson 単体のテスト用に、ダミー API のホストだけを許可する */
function withHost(baseUrl) {
  const c = baseConfig(os.tmpdir(), []);
  c.security.allowHosts = [baseUrl];
  return c;
}

async function captureStderr(fn) {
  const orig = process.stderr.write;
  let out = '';
  process.stderr.write = (chunk) => { out += String(chunk); return true; };
  try { await fn(); } finally { process.stderr.write = orig; }
  return out;
}

async function startServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    // 無限ループの退行でもテストが終わるよう、一定数を超えたら 404（再試行されない）で落とす
    if (calls.length > 40) { res.writeHead(404); res.end('{}'); return; }
    handler(req, res, calls);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const json = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

// ---- 1. GitHub ツリーの truncated ----

async function runGithubTree(treeBody) {
  const api = await startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/repos/o/r/commits/HEAD') return json(res, { sha: 'abc' });
    if (u.pathname.startsWith('/repos/o/r/git/trees/')) return json(res, treeBody);
    res.writeHead(404); res.end('{}');
  });
  const root = tmpDir('cg-trunc-');
  try {
    const src = { id: 'gh', type: 'github', repo: 'o/r', mode: 'api', apiBaseUrl: api.baseUrl };
    const config = baseConfig(root, [src]);
    initEgress(config);
    let result;
    const err = await captureStderr(async () => {
      result = await syncGithub(src, { config, paths: { repos: path.join(root, 'repos') } });
    });
    return { ...result, err };
  } finally { await api.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('github(api): tree.truncated が真なら警告し、state.truncated を立てる', async () => {
  const { state, err } = await runGithubTree({ tree: [], truncated: true });
  assert.equal(state.truncated, true);
  assert.match(err, /truncated|一部/);
  assert.match(err, /clone/);
});

test('github(api): truncated が false / 無しなら警告せず、state にキー自体を足さない', async () => {
  for (const body of [{ tree: [], truncated: false }, { tree: [] }]) {
    const { state, err } = await runGithubTree(body);
    assert.equal(Object.hasOwn(state, 'truncated'), false);
    assert.doesNotMatch(err, /clone/);
  }
});

// ---- 2. httpJson: 2xx なのに JSON でない ----

test('httpJson: 2xx で JSON でない本文は noRetry で 1 回だけ要求し、本文は載せない', async () => {
  const api = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>login page SECRETBODY</html>');
  });
  try {
    initEgress(withHost(api.baseUrl));
    await assert.rejects(
      () => httpJson(`${api.baseUrl}/x?token=QUERYSECRET`, { purpose: 'test' }),
      (e) => {
        assert.equal(e.noRetry, true);
        assert.match(e.message, /JSON でない応答/);
        assert.match(e.message, /text\/html/);
        assert.ok(!e.message.includes('SECRETBODY'));
        assert.ok(!e.message.includes('QUERYSECRET'));
        return true;
      });
    assert.equal(api.calls.length, 1);
  } finally { await api.close(); }
});

test('httpJson: 正常な JSON と空本文は従来どおり', async () => {
  const api = await startServer((req, res) => {
    if (req.url === '/empty') { res.writeHead(200); res.end(''); return; }
    json(res, { ok: 1 });
  });
  try {
    initEgress(withHost(api.baseUrl));
    assert.deepEqual(await httpJson(`${api.baseUrl}/j`, { purpose: 'test' }), { ok: 1 });
    assert.equal(await httpJson(`${api.baseUrl}/empty`, { purpose: 'test' }), null);
  } finally { await api.close(); }
});

// ---- 3. Confluence のページネーション ----

async function runConfluence(srcExtra, handler) {
  const api = await startServer(handler);
  const root = tmpDir('cg-conf-');
  const prev = process.env.ATLASSIAN_BEARER;
  process.env.ATLASSIAN_BEARER = 'dummy-bearer';
  try {
    const src = { id: 'cf', type: 'confluence', baseUrl: api.baseUrl, ...srcExtra };
    const config = baseConfig(root, [src]);
    initEgress(config);
    let result;
    const err = await captureStderr(async () => { result = await syncConfluence(src, {}); });
    return { ...result, err, calls: api.calls };
  } finally {
    if (prev === undefined) delete process.env.ATLASSIAN_BEARER; else process.env.ATLASSIAN_BEARER = prev;
    await api.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}

const page = (id) => ({ id: String(id), title: `p${id}`, body: { storage: { value: '<p>x</p>' } } });

test('confluence: 子ページ取得が同じ next を返し続けても止まる', async () => {
  const { calls, err } = await runConfluence({ pageIds: ['1'], includeDescendants: true }, (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/v2/pages/1/children') {
      return json(res, { results: [{ id: 2 }], _links: { next: '/api/v2/pages/1/children?limit=250&cursor=x' } });
    }
    json(res, { results: [] });
  });
  const own = calls.filter((c) => c.startsWith('/api/v2/pages/1/children'));
  assert.ok(own.length <= 3, `children 要求 ${own.length} 回`);
  assert.match(err, /next|ページネーション/);
});

test('confluence: 子ページの通常のページネーション（next が毎回違う）は全部辿る', async () => {
  const { calls } = await runConfluence({ pageIds: ['1'], includeDescendants: true }, (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/v2/pages/1/children') {
      const n = Number(u.searchParams.get('cursor') || 0);
      return json(res, { results: [{ id: 10 + n }], _links: n < 3 ? { next: `/api/v2/pages/1/children?limit=250&cursor=${n + 1}` } : {} });
    }
    json(res, { results: [] });
  });
  assert.equal(calls.filter((c) => c.startsWith('/api/v2/pages/1/children')).length, 4);
});

test('confluence: CQL 検索が同じ next を返し続けても止まる', async () => {
  const { calls, docs, err } = await runConfluence({ cql: 'type = page' }, (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/rest/api/content/search') {
      return json(res, { results: [page(1)], _links: { next: '/rest/api/content/search?cql=x&cursor=same' } });
    }
    res.writeHead(404); res.end('{}');
  });
  assert.ok(calls.length <= 3, `要求 ${calls.length} 回`);
  assert.equal(docs.length, 1);
  assert.match(err, /next|ページネーション/);
});

test('confluence: CQL 検索の通常のページネーションは全部辿る', async () => {
  const { calls, docs } = await runConfluence({ cql: 'type = page' }, (req, res) => {
    const u = new URL(req.url, 'http://x');
    const n = Number(u.searchParams.get('cursor') || 0);
    json(res, { results: [page(n + 1)], _links: n < 2 ? { next: `/rest/api/content/search?cql=x&cursor=${n + 1}` } : {} });
  });
  assert.equal(calls.length, 3);
  assert.equal(docs.length, 3);
});

test('confluence: スペース取り込みが同じ next を返し続けても止まる', async () => {
  const { calls, err } = await runConfluence({ spaceId: '9' }, (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/v2/pages') {
      return json(res, { results: [page(1)], _links: { next: '/api/v2/pages?cursor=same' } });
    }
    res.writeHead(404); res.end('{}');
  });
  assert.ok(calls.length <= 3, `要求 ${calls.length} 回`);
  assert.match(err, /next|ページネーション/);
});

test('confluence: スペース取り込みの通常のページネーションは全部辿る', async () => {
  const { calls, docs } = await runConfluence({ spaceId: '9' }, (req, res) => {
    const u = new URL(req.url, 'http://x');
    const n = Number(u.searchParams.get('cursor') || 0);
    json(res, { results: [page(n + 1)], _links: n < 2 ? { next: `/api/v2/pages?cursor=${n + 1}` } : {} });
  });
  assert.equal(calls.length, 3);
  assert.equal(docs.length, 3);
});
