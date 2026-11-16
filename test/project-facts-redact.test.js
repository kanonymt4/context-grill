import test from 'node:test';
import assert from 'node:assert/strict';

import { projectFacts } from '../src/analysis/static.js';

// projectFacts() の戻り値そのものが墨消し済みであることの検査。
// MCP の static_scan（project_facts）と CLI の scan（facts）はこの戻り値をそのまま出力する。
// ダミートークンは実在しない文字列（分割連結で書く）。
const TOKEN_BODY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TOKEN = 'ghp' + '_' + TOKEN_BODY;
const PW = 'hunter2pw';

function pkgDoc(pkg) {
  return { kind: 'config', sourceId: 's', sourceType: 'local', path: 'package.json', url: null, text: JSON.stringify(pkg) };
}

test('projectFacts: name に入ったトークンが戻り値で墨消しされる', () => {
  const facts = projectFacts([pkgDoc({ name: `app-${TOKEN}` })]);
  const json = JSON.stringify(facts);
  assert.ok(!json.includes(TOKEN_BODY), `戻り値に生のトークンが残っている: ${json}`);
  assert.ok(json.includes('«REDACTED:'), `墨消し印が無い: ${json}`);
});

test('projectFacts: 依存のバージョンに入った URL の認証情報が戻り値で墨消しされる', () => {
  const facts = projectFacts([pkgDoc({ name: 'x', dependencies: { dep: `>=1 https://user:${PW}@host.example/x` } })]);
  const risk = facts.find((f) => f.kind === 'deps-risk');
  assert.ok(risk, 'deps-risk が出ていない');
  assert.ok(!JSON.stringify(facts).includes(PW), `戻り値に生のパスワードが残っている: ${risk.detail}`);
});

test('projectFacts(対照): 通常の観測値は変わらない', () => {
  const facts = projectFacts([pkgDoc({ name: 'my-app', dependencies: { loose: '*', other: '^1.0.0' }, scripts: { start: 'node .' } })]);
  const by = Object.fromEntries(facts.map((f) => [f.kind, f.detail]));
  assert.equal(by.deps, 'name=my-app / dependencies=2 / devDependencies=0 / engines=null');
  assert.equal(by['deps-risk'], 'バージョン範囲が緩い依存: loose@*');
  assert.equal(by.lockfile, 'lockfile が索引内に見つからない（除外設定または未コミット）');
  assert.equal(by.scripts, 'npm scripts: start');
});
