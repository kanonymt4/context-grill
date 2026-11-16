// 埋め込み API のエラー本文は「墨消ししてから」切る（切り口にまたがった秘密値の断片を残さない）
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import fsp from 'node:fs/promises';

import { embedChunks, embedQuery } from '../src/index/embed.js';
import { initEgress } from '../src/util/egress.js';
import { redactMessage } from '../src/util/redact.js';

const TOKEN = 'ghp' + '_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

// 400 字目の手前（380 字目）からトークンが始まり、切り口にまたがる本文
function boundaryBody() {
  return 'ab '.repeat(126) + 'zz' + ' ' + TOKEN + ' ' + 'tail '.repeat(20);
}

async function withServer(status, body, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-embred-'));
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(body); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const cfg = { provider: 'openai-compat', model: 'm', dimensions: 4, baseUrl, apiKeyEnv: 'TEST_EMBED_REDACT_KEY', batch: 2 };
  initEgress({ sources: [], llm: { provider: 'dry' }, retrieval: { embedding: cfg }, security: { auditLog: false }, workspaceDir: dir });
  process.env.TEST_EMBED_REDACT_KEY = 'dummy';
  try { return await fn(cfg, dir); } finally {
    delete process.env.TEST_EMBED_REDACT_KEY;
    await new Promise((r) => server.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('前提: fixture は 400 字の切り口にトークンをまたがせ、全体なら墨消しされる', () => {
  const body = boundaryBody();
  assert.ok(body.indexOf(TOKEN) < 400 && body.indexOf(TOKEN) + TOKEN.length > 400, 'トークンが 400 字目をまたぐ');
  assert.ok(!redactMessage(body).includes('ghp_'), '全体を墨消しすればトークンは消える');
  assert.ok(redactMessage(body.slice(0, 400)).includes('ghp_'), '先に切ると断片が残る（これが不具合）');
});

test('embedQuery: 切り口にまたがった秘密値がエラーメッセージに残らない', async () => {
  await withServer(401, boundaryBody(), async (cfg) => {
    await assert.rejects(() => embedQuery('q', cfg), (e) => {
      assert.ok(!e.message.includes('ghp_'), `断片が残っている: ${e.message.slice(-80)}`);
      assert.match(e.message, /openai-compat embeddings HTTP 401/);
      return true;
    });
  });
});

test('embedChunks: 切り口にまたがった秘密値がエラーメッセージに残らない', async () => {
  await withServer(401, boundaryBody(), async (cfg, dir) => {
    await assert.rejects(
      () => embedChunks([{ hash: 'h0', text: 'a' }], cfg, dir, { security: { allowEmbeddingUpload: true } }),
      (e) => { assert.ok(!e.message.includes('ghp_'), `断片が残っている: ${e.message.slice(-80)}`); return true; });
  });
});

test('対照: 短い本文はメッセージが変わらない', async () => {
  await withServer(401, 'invalid api key', async (cfg) => {
    await assert.rejects(() => embedQuery('q', cfg), (e) => {
      assert.equal(e.message, 'openai-compat embeddings HTTP 401: invalid api key');
      return true;
    });
  });
});
