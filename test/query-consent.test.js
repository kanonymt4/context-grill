import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';

import { initEgress } from '../src/util/egress.js';
import { hybridSearch } from '../src/index/search.js';

// クエリ埋め込みも security.allowEmbeddingUpload（埋め込み送信の明示同意）に従う。
// 同意が true でなければクエリ文を送らず、BM25 のみで検索して 1 回だけ警告する。
// 外部通信は 127.0.0.1 のダミー API だけ。

const KEY_ENV = 'CG_TEST_QUERY_CONSENT_KEY';
const SECRET_QUERY = 'login secret-query-text';

/** 受信したリクエスト本文を記録するダミー埋め込み API */
async function startServer() {
  const state = { bodies: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const cfg = { provider: 'openai-compat', model: 'test-embed', dimensions: 4, baseUrl, apiKeyEnv: KEY_ENV };
  return { state, cfg, close: () => new Promise((r) => server.close(r)) };
}

function setup(cfg) {
  process.env[KEY_ENV] = 'dummy';
  initEgress({
    sources: [], llm: { provider: 'dry' }, retrieval: { embedding: cfg },
    security: { networkMode: 'normal', auditLog: false }, workspaceDir: os.tmpdir(),
  });
}

function fakeStore(dims = 4) {
  const meta = [0, 1, 2].map((i) => ({ docId: `d${i}`, path: `f${i}.md`, title: `t${i}`, kind: 'doc', sourceId: 's' }));
  return {
    dims,
    meta,
    textOf: (i) => `text ${i}`,
    vecAt: () => null,
    chunkAt(i) { return { ...meta[i], idx: i, text: `text ${i}` }; },
    // BM25 は 0 → 1 → 2、ベクトル検索は 2 → 1 → 0 にして、融合の有無が順位に出るようにする
    bm25: () => [{ idx: 0, score: 3 }, { idx: 1, score: 2 }, { idx: 2, score: 1 }],
    vectorSearch: () => [{ idx: 2, score: 0.9 }, { idx: 1, score: 0.5 }, { idx: 0, score: 0.1 }],
  };
}

function searchConfig(embedding, security) {
  const config = {
    retrieval: {
      embedding,
      glossaryBridge: false,
      hybrid: { final: 3, rrfK: 60, mmrLambda: 0.72, perQueryTop: 10 },
      boosts: { pathMatch: 0, kindPrior: 0, sourcePriority: 0 },
    },
  };
  if (security !== undefined) config.security = security;
  return config;
}

async function captureStderr(fn) {
  const orig = process.stderr.write;
  const chunks = [];
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  try { return { result: await fn(), stderr: chunks.join('') }; } finally { process.stderr.write = orig; }
}

const CONSENT_WARN_RE = /クエリ埋め込みは送りません（security\.allowEmbeddingUpload が true ではないため）。BM25 のみで検索します/g;
const ids = (rs) => rs.map((r) => r.idx);

const noConsent = [
  ['allowEmbeddingUpload: false', { allowEmbeddingUpload: false }],
  ['allowEmbeddingUpload 未設定', { networkMode: 'normal' }],
  ['security なし', undefined],
];

for (const [label, security] of noConsent) {
  test(`hybridSearch: ${label} ならクエリを送信せず、BM25 のみで検索して警告は 1 回だけ（複数クエリでも）`, async () => {
    const s = await startServer();
    try {
      setup(s.cfg);
      const store = fakeStore();
      const queries = [SECRET_QUERY, 'second query'];
      const { result, stderr } = await captureStderr(() => hybridSearch(store, { queries, config: searchConfig(s.cfg, security) }));
      assert.equal(s.state.bodies.length, 0, `送信された本文: ${s.state.bodies.join(' | ')}`);
      assert.deepEqual(ids(result), [0, 1, 2], 'BM25 のみの順位');
      assert.equal((stderr.match(CONSENT_WARN_RE) || []).length, 1, stderr);
    } finally { delete process.env[KEY_ENV]; await s.close(); }
  });
}

test('hybridSearch(回帰): allowEmbeddingUpload: true ならクエリを送信し、ベクトル検索が融合され、警告は出ない', async () => {
  const s = await startServer();
  try {
    setup(s.cfg);
    const store = fakeStore();
    const config = searchConfig(s.cfg, { allowEmbeddingUpload: true });
    const { result, stderr } = await captureStderr(() => hybridSearch(store, { queries: [SECRET_QUERY], config }));
    assert.ok(s.state.bodies.length >= 1);
    assert.ok(s.state.bodies.some((b) => b.includes(SECRET_QUERY)));
    assert.notDeepEqual(ids(result), [0, 1, 2], 'ベクトルが融合されて順位が変わる');
    assert.ok(!/BM25 のみで検索します/.test(stderr), stderr);
  } finally { delete process.env[KEY_ENV]; await s.close(); }
});

test('hybridSearch: provider が none のときは、同意がなくても送信も警告もない', async () => {
  const s = await startServer();
  try {
    setup(s.cfg);
    const { result, stderr } = await captureStderr(() => hybridSearch(fakeStore(), {
      queries: [SECRET_QUERY], config: searchConfig({ provider: 'none' }, { allowEmbeddingUpload: false }),
    }));
    assert.equal(s.state.bodies.length, 0);
    assert.deepEqual(ids(result), [0, 1, 2]);
    assert.equal(stderr, '');
  } finally { delete process.env[KEY_ENV]; await s.close(); }
});

test('hybridSearch: ベクトル索引がない（dims なし）ときは、同意がなくても送信も警告もない', async () => {
  const s = await startServer();
  try {
    setup(s.cfg);
    const { stderr } = await captureStderr(() => hybridSearch(fakeStore(0), {
      queries: [SECRET_QUERY], config: searchConfig(s.cfg, { allowEmbeddingUpload: false }),
    }));
    assert.equal(s.state.bodies.length, 0);
    assert.equal(stderr, '');
  } finally { delete process.env[KEY_ENV]; await s.close(); }
});
