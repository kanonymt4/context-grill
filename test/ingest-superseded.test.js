import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { loadConfig, paths } from '../src/config.js';
import { syncSources, buildIndex } from '../src/index/ingest.js';
import { IndexBuilder, IndexStore, latestGen } from '../src/index/store.js';

// 埋め込みの応答を待つあいだに、別の builder が新しい世代を公開した場合の振る舞い。
// 置き換えられた builder は「BM25 のみで継続します」と言わずに、置き換えを理由に失敗する。
// 埋め込み API が単に失敗した場合（500）は、従来どおり警告して BM25 のみで公開する。
// 外部通信は 127.0.0.1 のダミー API だけ。

const KEY_ENV = 'CG_TEST_SUPERSEDED_KEY';
const CONTINUE_RE = /BM25 のみで継続/;

async function captureStderr(fn) {
  const orig = process.stderr.write;
  const chunks = [];
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  try { return { result: await fn(), stderr: chunks.join('') }; }
  catch (error) { return { error, stderr: chunks.join('') }; }
  finally { process.stderr.write = orig; }
}

/** onRequest(inputCount) が終わってから応答するダミー埋め込み API。status が 200 以外ならエラーを返す */
async function startServer({ status = 200, onRequest = async () => {} } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')).input;
      await onRequest(input.length);
      if (status !== 200) { res.writeHead(status); res.end('boom'); return; }
      // 応答数は入力数に合わせる（合わないと別の理由で catch に入る）
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

/** テストごとに別の workspace を使う（埋め込みキャッシュが workspace/cache/embed に残るため） */
async function fixture(baseUrl) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-superseded-'));
  await fsp.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'docs', 'a.md'), '# 仕様\n\n返金は最大 5 回までリトライする。\n');
  await fsp.writeFile(path.join(dir, 'context-grill.config.json'), JSON.stringify({
    project: 'superseded',
    sources: [{ id: 'wiki', type: 'local', path: dir, include: ['docs/**'] }],
    llm: { provider: 'dry', model: 'dry' },
    retrieval: { embedding: { provider: 'openai-compat', model: 'test-embed', dimensions: 4, baseUrl, apiKeyEnv: KEY_ENV } },
    security: { allowEmbeddingUpload: true },
  }));
  const config = await loadConfig(path.join(dir, 'context-grill.config.json'));
  return { dir, config };
}

test('埋め込み待ちのあいだに新しい世代が公開されたら、BM25 継続とは言わず置き換えで失敗する', async () => {
  process.env[KEY_ENV] = 'dummy';
  let config;
  const srv = await startServer({
    onRequest: async () => {
      // 応答する前に、同じ index ディレクトリで別の builder が新しい世代を公開する
      const b = new IndexBuilder(paths(config).index);
      await b.start();
      b.add({ text: 'other builder', title: 't', path: 'p.md', docId: 'x', sourceId: 's', kind: 'doc' });
      await b.finish();
    },
  });
  try {
    const fx = await fixture(srv.baseUrl);
    config = fx.config;
    await syncSources(config, {});
    const { error, stderr } = await captureStderr(() => buildIndex(config, { embed: true }));
    assert.ok(error, 'buildIndex は失敗する');
    assert.match(error.message, /置き換え/);
    assert.doesNotMatch(stderr, CONTINUE_RE, '「継続します」と言ってはいけない');
    const indexDir = paths(config).index;
    assert.equal(latestGen(indexDir), 2, '新しい世代が残る');
    const store = await IndexStore.open(indexDir);
    try { assert.equal(store.stats().chunks, 1); } finally { await store.close(); }
    await fsp.rm(fx.dir, { recursive: true, force: true });
  } finally { await srv.close(); delete process.env[KEY_ENV]; }
});

test('埋め込み API が 500 を返すときは、警告して BM25 のみで公開する（従来どおり）', async () => {
  process.env[KEY_ENV] = 'dummy';
  const srv = await startServer({ status: 500 });
  try {
    const fx = await fixture(srv.baseUrl);
    await syncSources(fx.config, {});
    const { result, error, stderr } = await captureStderr(() => buildIndex(fx.config, { embed: true }));
    assert.ifError(error);
    assert.match(stderr, CONTINUE_RE);
    assert.equal(result.dims, 0);
    assert.equal(latestGen(paths(fx.config).index), 1);
    await fsp.rm(fx.dir, { recursive: true, force: true });
  } finally { await srv.close(); delete process.env[KEY_ENV]; }
});
