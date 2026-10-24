import test from 'node:test';
import assert from 'node:assert/strict';

import { extractEndpoints, scanAll, renderStaticFacts } from '../src/analysis/static.js';

// 静的解析の endpoints（snippet / route）が、findings と同様に墨消しされることの検査。
// ダミートークンは実在しない文字列（秘密情報検出のテスト用）。
const TOKEN_BODY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TOKEN = `ghp_${TOKEN_BODY}`;

function codeDoc(text, path = 'src/app.js') {
  return { kind: 'code', sourceId: 'src1', sourceType: 'local', path, url: null, text };
}

test('endpoints: snippet に埋め込まれたトークンが墨消しされる', () => {
  const doc = codeDoc(`app.get('/admin', basicAuth({users:{admin:"${TOKEN}"}}), handler);`);
  const eps = extractEndpoints([doc]);
  assert.equal(eps.length, 1);
  assert.ok(!eps[0].snippet.includes(TOKEN_BODY), `snippet に生のトークンが残っている: ${eps[0].snippet}`);
  assert.ok(eps[0].snippet.includes('«REDACTED:'), `snippet に墨消し印が無い: ${eps[0].snippet}`);
  assert.equal(eps[0].route, '/admin');
});

test('endpoints: route に含まれるトークンが墨消しされる', () => {
  const doc = codeDoc(`router.post('/api/${TOKEN}/hook', handler);`);
  const eps = extractEndpoints([doc]);
  assert.equal(eps.length, 1);
  assert.ok(!eps[0].route.includes(TOKEN_BODY), `route に生のトークンが残っている: ${eps[0].route}`);
  assert.ok(!eps[0].snippet.includes(TOKEN_BODY), `snippet に生のトークンが残っている: ${eps[0].snippet}`);
});

test('endpoints: scanAll と同じ doc で findings と endpoints の両方にトークンが出ない', () => {
  const doc = codeDoc(`app.get('/admin', basicAuth({users:{admin:"${TOKEN}"}}), handler);`);
  const out = JSON.stringify({ findings: scanAll([doc]), endpoints: extractEndpoints([doc]) });
  assert.ok(!out.includes(TOKEN_BODY), 'findings / endpoints のどこかに生のトークンが残っている');
});

test('endpoints: renderStaticFacts（LLM に渡る文）にトークンが出ない', () => {
  const doc = codeDoc(`router.post('/api/${TOKEN}/hook', handler);`);
  const text = renderStaticFacts({ endpoints: extractEndpoints([doc]) }, 100000);
  assert.ok(text.includes('POST'), '回帰: エンドポイントの行は出力される');
  assert.ok(!text.includes(TOKEN_BODY), `渡る文に生のトークンが残っている: ${text}`);
});

test('endpoints(回帰): 通常の route / snippet / 返り値の形は変わらない', () => {
  const line = `app.get('/users/:id', auth, (req, res) => res.json({}));`;
  const doc = codeDoc(`const x = 1;\n  ${line}\n`);
  const eps = extractEndpoints([doc]);
  assert.deepEqual(eps, [{
    method: 'GET', route: '/users/:id', framework: 'express', sourceId: 'src1', path: 'src/app.js', line: 2,
    url: null, snippet: line,
  }]);
});

test('endpoints(回帰): snippet は従来どおり 200 字で切られる', () => {
  const doc = codeDoc(`app.get('/long', ${'a'.repeat(500)});`);
  const eps = extractEndpoints([doc]);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].snippet.length, 200);
});
