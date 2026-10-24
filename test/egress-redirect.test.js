import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initEgress, guardedFetch, EgressBlocked } from '../src/util/egress.js';

// guardedFetch のリダイレクト追従。外部通信は 127.0.0.1 / localhost のダミーサーバーだけ。
// 許可されたホストが別 origin へ 3xx を返しても、本文とヘッダを送らない（同じ origin のときだけ追従する）。

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    port: server.address().port,
    close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); },
  })));
}

/** 受信したリクエストを記録するサーバー。 */
async function startTarget() {
  const hits = [];
  const s = await listen((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('stolen');
    });
  });
  return { ...s, hits };
}

/** routes: パス -> (req, res, port) の関数。 */
async function startRouter(routes) {
  const s = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      const h = routes[req.url.split('?')[0]];
      if (h) h(req, res, s.port); else { res.writeHead(404); res.end('nf'); }
    });
  });
  return s;
}

function setup(allowHosts, { auditLog = false, workspaceDir = os.tmpdir() } = {}) {
  initEgress({
    sources: [], llm: { provider: 'dry' },
    security: { allowHosts, auditLog, networkMode: 'normal' },
    workspaceDir,
  });
}

const POST = { method: 'POST', headers: { 'x-api-key': 'KEY' }, body: 'SECRET-BODY' };

for (const code of [301, 302, 303, 307, 308]) {
  test(`redirect ${code}: 別ホストへの転送は拒否され、転送先に接続も本文もヘッダも届かない`, async () => {
    const b = await startTarget();
    const a = await startRouter({ '/go': (req, res) => { res.writeHead(code, { location: `http://localhost:${b.port}/x?token=Q` }); res.end(); } });
    try {
      setup([`127.0.0.1:${a.port}`]);
      await assert.rejects(
        () => guardedFetch(`http://127.0.0.1:${a.port}/go`, POST, { purpose: 't' }),
        (e) => {
          assert.ok(e instanceof EgressBlocked, `EgressBlocked のはず: ${e.name}`);
          assert.match(e.message, new RegExp(`localhost:${b.port}`));
          assert.doesNotMatch(e.message, /token=Q/);
          return true;
        });
      assert.equal(b.hits.length, 0);
    } finally { await a.close(); await b.close(); }
  });
}

test('redirect: 転送先も allowHosts にある別ホストでも拒否される（メッセージに理由が出る）', async () => {
  const b = await startTarget();
  const a = await startRouter({ '/go': (req, res) => { res.writeHead(307, { location: `http://localhost:${b.port}/x` }); res.end(); } });
  try {
    setup([`127.0.0.1:${a.port}`, `localhost:${b.port}`]);
    await assert.rejects(
      () => guardedFetch(`http://127.0.0.1:${a.port}/go`, POST, { purpose: 't' }),
      (e) => e instanceof EgressBlocked && /許可リストにあるホストでも、別ホストへのリダイレクトは追従しません/.test(e.message));
    assert.equal(b.hits.length, 0);
  } finally { await a.close(); await b.close(); }
});

test('redirect: 同じホストの別ポートへの転送は拒否される', async () => {
  const b = await startTarget();
  const a = await startRouter({ '/go': (req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${b.port}/x` }); res.end(); } });
  try {
    setup([`127.0.0.1:${a.port}`, `127.0.0.1:${b.port}`]);
    await assert.rejects(
      () => guardedFetch(`http://127.0.0.1:${a.port}/go`, POST, { purpose: 't' }),
      (e) => e instanceof EgressBlocked);
    assert.equal(b.hits.length, 0);
  } finally { await a.close(); await b.close(); }
});

test('redirect: メッセージに転送先の userinfo を含めない', async () => {
  const b = await startTarget();
  const a = await startRouter({ '/go': (req, res) => { res.writeHead(302, { location: `http://user:pw@localhost:${b.port}/x` }); res.end(); } });
  try {
    setup([`127.0.0.1:${a.port}`]);
    await assert.rejects(
      () => guardedFetch(`http://127.0.0.1:${a.port}/go`, POST, { purpose: 't' }),
      (e) => e instanceof EgressBlocked && !/user|pw@/.test(e.message));
  } finally { await a.close(); await b.close(); }
});

test('redirect(回帰): 自分の別パスへの 302 は追従して最終応答を返す', async () => {
  const a = await startRouter({
    '/x': (req, res) => { res.writeHead(302, { location: '/y' }); res.end(); },
    '/y': (req, res) => { res.writeHead(200); res.end('final'); },
  });
  try {
    setup([`127.0.0.1:${a.port}`]);
    const res = await guardedFetch(`http://127.0.0.1:${a.port}/x`, {}, { purpose: 't' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'final');
  } finally { await a.close(); }
});

test('redirect(回帰): 同一 origin への 307 は POST と本文を維持し、302 は GET に変わる', async () => {
  const seen = [];
  const a = await startRouter({
    '/p307': (req, res) => { res.writeHead(307, { location: '/dest' }); res.end(); },
    '/p302': (req, res) => { res.writeHead(302, { location: '/dest' }); res.end(); },
    '/dest': (req, res) => { seen.push(req.method); res.writeHead(200); res.end('ok'); },
  });
  try {
    setup([`127.0.0.1:${a.port}`]);
    await (await guardedFetch(`http://127.0.0.1:${a.port}/p307`, POST, { purpose: 't' })).text();
    await (await guardedFetch(`http://127.0.0.1:${a.port}/p302`, POST, { purpose: 't' })).text();
    assert.deepEqual(seen, ['POST', 'GET']);
  } finally { await a.close(); }
});

test('redirect(回帰): リダイレクトのループは上限（5 回）で EgressBlocked', async () => {
  let count = 0;
  const a = await startRouter({ '/loop': (req, res) => { count++; res.writeHead(302, { location: '/loop' }); res.end(); } });
  try {
    setup([`127.0.0.1:${a.port}`]);
    await assert.rejects(
      () => guardedFetch(`http://127.0.0.1:${a.port}/loop`, {}, { purpose: 't' }),
      (e) => e instanceof EgressBlocked && /上限/.test(e.message));
    assert.equal(count, 6); // 最初の 1 回 + 追従 5 回
  } finally { await a.close(); }
});

test('redirect(回帰): 通常の応答と 4xx/5xx はそのまま返る。Location の無い 3xx も返る', async () => {
  const a = await startRouter({
    '/ok': (req, res) => { res.writeHead(200); res.end('hi'); },
    '/e404': (req, res) => { res.writeHead(404); res.end('nf'); },
    '/e500': (req, res) => { res.writeHead(500); res.end('boom'); },
    '/noloc': (req, res) => { res.writeHead(302); res.end('x'); },
    '/nm': (req, res) => { res.writeHead(304); res.end(); },
  });
  try {
    setup([`127.0.0.1:${a.port}`]);
    const get = (p) => guardedFetch(`http://127.0.0.1:${a.port}${p}`, {}, { purpose: 't' });
    assert.equal((await get('/ok')).status, 200);
    assert.equal((await get('/e404')).status, 404);
    assert.equal((await get('/e500')).status, 500);
    assert.equal((await get('/noloc')).status, 302);
    assert.equal((await get('/nm')).status, 304);
  } finally { await a.close(); }
});

test('redirect: audit ログにホップごとの行が残り、2 ホップ目以降の purpose に (redirect) が付く', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-egress-redirect-'));
  const a = await startRouter({
    '/x': (req, res) => { res.writeHead(302, { location: '/y?secret=1' }); res.end(); },
    '/y': (req, res) => { res.writeHead(200); res.end('final'); },
  });
  try {
    setup([`127.0.0.1:${a.port}`], { auditLog: true, workspaceDir: dir });
    await (await guardedFetch(`http://127.0.0.1:${a.port}/x`, {}, { purpose: 'tp' })).text();
    const lines = fs.readFileSync(path.join(dir, 'egress.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].purpose, 'tp');
    assert.equal(lines[0].status, 302);
    assert.equal(lines[1].purpose, 'tp (redirect)');
    assert.equal(lines[1].status, 200);
    assert.equal(lines[1].url, `http://127.0.0.1:${a.port}/y`);
  } finally { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('redirect: 拒否した転送も audit に残る（元のホップは 3xx、転送先には送っていない）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-egress-redirect-'));
  const b = await startTarget();
  const a = await startRouter({ '/go': (req, res) => { res.writeHead(307, { location: `http://localhost:${b.port}/x` }); res.end(); } });
  try {
    setup([`127.0.0.1:${a.port}`], { auditLog: true, workspaceDir: dir });
    await assert.rejects(() => guardedFetch(`http://127.0.0.1:${a.port}/go`, POST, { purpose: 'tp' }), EgressBlocked);
    const lines = fs.readFileSync(path.join(dir, 'egress.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].status, 307);
    assert.equal(b.hits.length, 0);
  } finally { await a.close(); await b.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
