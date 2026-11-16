import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';

import { redactMessage } from '../src/util/redact.js';
import { initEgress } from '../src/util/egress.js';
import { httpJson } from '../src/connectors/base.js';
import { createProvider } from '../src/llm/provider.js';

// HTTP エラー本文の墨消しは「切る前」に行う。切り口に秘密値がまたがると規則に一致せず、断片が例外メッセージに出る。
// 外部通信は 127.0.0.1 のダミーサーバーだけ。

// 分割連結で書く（push 保護に当たらないように）
const TOKEN = 'ghp' + '_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

/** 境界（cut）をトークンがまたぐ本文。トークンは cut の 10 字手前から始まる。 */
function bodyAcross(cut, total = cut + 200) {
  const start = cut - 10;
  // 前後は空白にする（語の途中だと \b の規則に一致せず、切る前でも墨消しされないため）
  const body = 'x'.repeat(start - 1) + ' ' + TOKEN + ' ' + 'y'.repeat(total - start - TOKEN.length - 2);
  // 前提確認: 切り口がトークンの内側にある（切った側に 20 字未満の断片が残る）
  assert.ok(start < cut && cut < start + TOKEN.length);
  assert.equal(body.slice(start, start + TOKEN.length), TOKEN);
  // 前提確認: 全体を墨消しすればトークンは消える（切る前なら検出できる fixture）
  assert.doesNotMatch(redactMessage(body), /ghp_/);
  return body;
}

async function startServer(status, body) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(body); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); },
  };
}

function setup(port) {
  initEgress({
    sources: [], llm: { provider: 'dry' },
    security: { allowHosts: [`127.0.0.1:${port}`], auditLog: false, networkMode: 'normal' },
    workspaceDir: os.tmpdir(),
  });
}

function llm(port) {
  process.env.CG_TEST_LLM_KEY = 'dummy-key-for-test';
  return createProvider({ provider: 'openai-compat', model: 'm', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'CG_TEST_LLM_KEY' });
}

test('httpJson: 600 字の切り口にまたがるトークンがエラーメッセージに残らない', async () => {
  const s = await startServer(401, bodyAcross(600));
  try {
    setup(s.port);
    await assert.rejects(
      () => httpJson(`http://127.0.0.1:${s.port}/x?q=1`, { purpose: 't' }),
      (e) => {
        assert.doesNotMatch(e.message, /ghp_/);
        assert.match(e.message, /^HTTP 401 /);
        return true;
      });
  } finally { await s.close(); }
});

test('httpJson(対照): 短い本文ではメッセージの先頭と本文が変わらない', async () => {
  const s = await startServer(401, 'bad credentials');
  try {
    setup(s.port);
    await assert.rejects(
      () => httpJson(`http://127.0.0.1:${s.port}/x?q=1`, { purpose: 't' }),
      (e) => {
        assert.equal(e.message, `HTTP 401 Unauthorized for http://127.0.0.1:${s.port}/x\nbad credentials`);
        return true;
      });
  } finally { await s.close(); }
});

test('httpJson: 本文が長くても先頭 600 字だけが残る（先頭の HTTP 行は切らない）', async () => {
  const s = await startServer(401, 'z'.repeat(5000));
  try {
    setup(s.port);
    await assert.rejects(
      () => httpJson(`http://127.0.0.1:${s.port}/x`, { purpose: 't' }),
      (e) => {
        const [head, body] = e.message.split('\n');
        assert.match(head, /^HTTP 401 .* for http:\/\/127\.0\.0\.1:\d+\/x$/);
        assert.equal(body.length, 600);
        return true;
      });
  } finally { await s.close(); }
});

test('LLM request: 800 字の切り口にまたがるトークンがエラーメッセージに残らない', async () => {
  const s = await startServer(401, bodyAcross(800));
  try {
    setup(s.port);
    await assert.rejects(
      () => llm(s.port).complete({ user: 'q' }),
      (e) => {
        assert.doesNotMatch(e.message, /ghp_/);
        assert.match(e.message, /^LLM API HTTP 401: /);
        return true;
      });
  } finally { delete process.env.CG_TEST_LLM_KEY; await s.close(); }
});

test('LLM request(対照): 短い本文ではメッセージが変わらない', async () => {
  const s = await startServer(401, 'invalid api key');
  try {
    setup(s.port);
    await assert.rejects(
      () => llm(s.port).complete({ user: 'q' }),
      (e) => { assert.equal(e.message, 'LLM API HTTP 401: invalid api key'); return true; });
  } finally { delete process.env.CG_TEST_LLM_KEY; await s.close(); }
});
