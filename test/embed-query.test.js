import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';

import { initEgress } from '../src/util/egress.js';
import { embedQuery } from '../src/index/embed.js';
import { hybridSearch } from '../src/index/search.js';

// クエリ埋め込みの失敗の扱い。外部通信は 127.0.0.1 のダミー API だけ。
// 1. 401 / 403 は再試行しない（認証エラーは再試行しても直らない）。5xx は従来どおり再試行する
// 2. hybridSearch は埋め込みに失敗したら、1 回の呼び出しにつき 1 回だけ stderr に警告して BM25 のみで続ける

const KEY_ENV = 'CG_TEST_EMBED_QUERY_KEY';

/** status が 200 以外ならそのステータスを返すダミー埋め込み API。受信回数を数える。 */
async function startServer(status) {
  const state = { count: 0 };
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      state.count++;
      if (status !== 200) { res.writeHead(status, { 'content-type': 'text/plain' }); res.end('denied'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const cfg = { provider: 'openai-compat', model: 'test-embed', dimensions: 4, baseUrl, apiKeyEnv: KEY_ENV };
  return { state, cfg, close: () => new Promise((r) => server.close(r)) };
}

function setup(cfg, networkMode = 'normal') {
  process.env[KEY_ENV] = 'dummy';
  initEgress({
    sources: [], llm: { provider: 'dry' }, retrieval: { embedding: cfg },
    security: { networkMode, auditLog: false }, workspaceDir: os.tmpdir(),
  });
}

for (const status of [401, 403]) {
  test(`embedQuery: HTTP ${status} は再試行せず 1 回だけ送信する`, async () => {
    const s = await startServer(status);
    try {
      setup(s.cfg);
      await assert.rejects(() => embedQuery('q', s.cfg), new RegExp(`HTTP ${status}`));
      assert.equal(s.state.count, 1);
    } finally { delete process.env[KEY_ENV]; await s.close(); }
  });
}

test('embedQuery(回帰): HTTP 500 は従来どおり再試行される', async () => {
  const s = await startServer(500);
  try {
    setup(s.cfg);
    await assert.rejects(() => embedQuery('q', s.cfg), /HTTP 500/);
    assert.equal(s.state.count, 3);
  } finally { delete process.env[KEY_ENV]; await s.close(); }
});

// ---- hybridSearch ----

function fakeStore() {
  const meta = [0, 1, 2].map((i) => ({ docId: `d${i}`, path: `f${i}.md`, title: `t${i}`, kind: 'doc', sourceId: 's' }));
  return {
    dims: 4,
    meta,
    textOf: (i) => `text ${i}`,
    vecAt: () => null,
    chunkAt(i) { return { ...meta[i], idx: i, text: `text ${i}` }; },
    // BM25 は 0 → 1 → 2、ベクトル検索は 2 → 1 → 0 の順位にして、融合結果が変わるようにする
    bm25: () => [{ idx: 0 }, { idx: 1 }, { idx: 2 }],
    vectorSearch: () => [{ idx: 2 }, { idx: 1 }, { idx: 0 }],
  };
}

function searchConfig(embedding) {
  return {
    retrieval: {
      embedding,
      glossaryBridge: false,
      hybrid: { final: 3, rrfK: 60, mmrLambda: 0.72, perQueryTop: 10 },
      boosts: { pathMatch: 0, kindPrior: 0, sourcePriority: 0 },
    },
  };
}

/** process.stderr.write を差し替えて、fn の間に書かれた文字列を集める */
async function captureStderr(fn) {
  const orig = process.stderr.write;
  const chunks = [];
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  try { return { result: await fn(), stderr: chunks.join('') }; } finally { process.stderr.write = orig; }
}

const WARN_RE = /クエリ埋め込みを使えないため BM25 のみで検索します/g;
const ids = (rs) => rs.map((r) => r.idx);

test('hybridSearch: 埋め込みが 401 で失敗しても警告は 1 回だけ（複数クエリでも）、結果は BM25 のみと一致する', async () => {
  const s = await startServer(401);
  try {
    setup(s.cfg);
    const store = fakeStore();
    const queries = ['alpha', 'beta', 'gamma'];
    const { result, stderr } = await captureStderr(() => hybridSearch(store, { queries, config: searchConfig(s.cfg) }));
    assert.equal((stderr.match(WARN_RE) || []).length, 1, `stderr: ${stderr}`);
    assert.match(stderr, /HTTP 401/);
    const bm25Only = await hybridSearch(store, { queries, config: searchConfig({ provider: 'none' }) });
    assert.deepEqual(ids(result), ids(bm25Only));
    assert.equal(s.state.count, queries.length);
  } finally { delete process.env[KEY_ENV]; await s.close(); }
});

test('hybridSearch: --offline で埋め込みが拒否されたときも警告が 1 回出て、BM25 のみで続く', async () => {
  const s = await startServer(200);
  try {
    setup(s.cfg, 'offline');
    const store = fakeStore();
    const queries = ['alpha', 'beta'];
    const { result, stderr } = await captureStderr(() => hybridSearch(store, { queries, config: searchConfig(s.cfg) }));
    assert.equal((stderr.match(WARN_RE) || []).length, 1, `stderr: ${stderr}`);
    const bm25Only = await hybridSearch(store, { queries, config: searchConfig({ provider: 'none' }) });
    assert.deepEqual(ids(result), ids(bm25Only));
    assert.equal(s.state.count, 0, 'オフラインでは送信しない');
  } finally { delete process.env[KEY_ENV]; await s.close(); }
});

test('hybridSearch: 埋め込みが成功したときは警告を出さず、ベクトル検索が融合される', async () => {
  const s = await startServer(200);
  try {
    setup(s.cfg);
    const store = fakeStore();
    const queries = ['alpha', 'beta'];
    const { result, stderr } = await captureStderr(() => hybridSearch(store, { queries, config: searchConfig(s.cfg) }));
    assert.equal(stderr, '');
    assert.equal(s.state.count, queries.length);
    const bm25Only = await hybridSearch(store, { queries, config: searchConfig({ provider: 'none' }) });
    assert.notDeepEqual(ids(result), ids(bm25Only), 'ベクトル検索の結果が融合されていること（fixture の前提確認）');
  } finally { delete process.env[KEY_ENV]; await s.close(); }
});
