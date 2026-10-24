import test from 'node:test';
import assert from 'node:assert/strict';
import { planQueries, planQueriesDetailed } from '../src/tasks/index.js';

test('planQueries: camelCase の識別子が独立クエリになる', () => {
  const qs = planQueries('bug', 'retryPolicy を確認し maxRetries の扱いを調べる', { max: 12 });
  assert.ok(qs.includes('retryPolicy'), `retryPolicy が無い: ${JSON.stringify(qs)}`);
  assert.ok(qs.includes('maxRetries'), `maxRetries が無い: ${JSON.stringify(qs)}`);
});

test('planQueries: camelCase・PascalCase・snake_case・パスの抽出が共存し、重複しない', () => {
  const qs = planQueries('bug', 'verifySessionToken と TimeoutError と payment_service と src/a.js と verifySessionToken', { max: 12 });
  for (const w of ['verifySessionToken', 'TimeoutError', 'payment_service', 'src/a.js']) {
    assert.equal(qs.filter((q) => q === w).length, 1, `${w} が 1 件でない: ${JSON.stringify(qs)}`);
  }
});

test('planQueries: 英文のアポストロフィを引用符として扱わない', () => {
  const instruction = "the user's session isn't valid";
  const qs = planQueries('bug', instruction, { max: 12 });
  assert.ok(!qs.includes('s session isn'), `断片が残っている: ${JSON.stringify(qs)}`);
  assert.deepEqual(qs.filter((q) => !q.includes(instruction)), [], `独立クエリが作られた: ${JSON.stringify(qs)}`);
  assert.equal(qs[0], instruction);
  assert.ok(qs[0].includes("user's") && qs[0].includes("isn't"));
});

test("planQueries: 単引用符 'retry limit' は引き続き独立クエリになる（回帰ガード）", () => {
  const qs = planQueries('bug', "check 'retry limit' now", { max: 12 });
  assert.ok(qs.includes('retry limit'), JSON.stringify(qs));
  assert.equal(qs.filter((q) => !q.includes("check 'retry limit' now")).length, 1);
  const text = "check 'foo_bar' and don't stop";
  const ids = planQueries('bug', text, { max: 12 });
  // 指示文全体を含まないクエリ = 抽出された独立クエリ
  assert.deepEqual(ids.filter((q) => !q.includes(text)), ['foo_bar']);
});

test('planQueries: 引用符と共存する英文のアポストロフィでも断片を作らない', () => {
  const text = "the user's 'retry limit' isn't applied";
  const qs = planQueries('bug', text, { max: 12 });
  assert.deepEqual(qs.filter((q) => !q.includes(text)), ['retry limit']);
});

test('planQueries: 「」「」の既存の挙動（ASCII の " と 「」）は変わらない', () => {
  const qs = planQueries('bug', '「認証」と "token refresh" を調べる', { max: 12 });
  assert.ok(qs.includes('認証'));
  assert.ok(qs.includes('token refresh'));
});

test('planQueries: 上限で落とした概念が queriesDropped と log で通知される', () => {
  const instruction = '「認証」「課金」「在庫」「配送」を調べる';
  const r = planQueriesDetailed('spec', instruction, { max: 3 });
  assert.equal(r.queries.length, 3);
  assert.deepEqual(r.queries, planQueries('spec', instruction, { max: 3 }));
  assert.deepEqual(r.queriesDropped, ['在庫', '配送']);

  const written = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { written.push(String(s)); return true; };
  try { planQueries('spec', instruction, { max: 3 }); } finally { process.stderr.write = orig; }
  const line = written.find((s) => s.includes('検索クエリの上限（3）を超えたため'));
  assert.ok(line, JSON.stringify(written));
  assert.ok(line.includes('在庫') && line.includes('配送'));
});

test('planQueries: 落とした概念が無ければ通知しない', () => {
  const r = planQueriesDetailed('spec', '「認証」を調べる', { max: 6 });
  assert.deepEqual(r.queriesDropped, []);
  const written = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { written.push(String(s)); return true; };
  try { planQueries('spec', '「認証」を調べる', { max: 6 }); } finally { process.stderr.write = orig; }
  assert.ok(!written.some((s) => s.includes('を超えたため')));
});
