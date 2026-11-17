import test from 'node:test';
import assert from 'node:assert/strict';
import { planQueries, planQueriesDetailed } from '../src/tasks/index.js';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

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

// ---- idents 正規表現の指数時間（ドットの連続）対策 ----

// 修正前の idents 抽出（差分テスト用に複製。第 1 選択肢が指数時間になる）
const IDENTS_OLD = /\b([A-Za-z_][A-Za-z0-9_]*(?:[./][A-Za-z0-9_.-]+)+|[A-Z][a-z]+[A-Z][A-Za-z0-9]+|[a-z]+(?:[A-Z][a-z0-9]*)+|[a-z]+_[a-z_]+)\b/g;
const IDENTS_NEW = /\b([A-Za-z_][A-Za-z0-9_]*[./][A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*|[A-Z][a-z]+[A-Z][A-Za-z0-9]+|[a-z]+(?:[A-Z][a-z0-9]*)+|[a-z]+_[a-z_]+)\b/g;
const extract = (re, s) => [...s.matchAll(re)].map((m) => [m.index, m[1]]);

test('planQueries: ドットが続く入力でも固まらない（子プロセス・5 秒以内）', () => {
  const url = pathToFileURL(fileURLToPath(new URL('../src/tasks/index.js', import.meta.url))).href;
  const script = `import(${JSON.stringify(url)}).then((m) => { m.planQueries('bug', 'loading' + '.'.repeat(60), { max: 12 }); });`;
  const r = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8' });
  assert.equal(r.error, undefined, `タイムアウトまたは起動失敗: ${r.error?.message}`);
  assert.equal(r.status, 0, `終了コード ${r.status}: ${r.stderr}`);
});

test('planQueries(回帰): 通常の識別子・パスの抽出は変わらない', () => {
  const text = 'src/util/redact.js と foo.bar.baz と a/b/c.txt と snake_case_name';
  const qs = planQueries('bug', text, { max: 12 });
  const concepts = qs.filter((q) => !q.includes(text));
  for (const w of ['src/util/redact.js', 'foo.bar.baz', 'a/b/c.txt', 'snake_case_name']) {
    assert.ok(concepts.includes(w), `${w} が無い: ${JSON.stringify(concepts)}`);
  }
  // 対照: 末尾のドット・ハイフンは識別子に含めない
  assert.deepEqual(extract(IDENTS_NEW, 'see foo.bar. and x/y-'), extract(IDENTS_OLD, 'see foo.bar. and x/y-'));
});

test('idents(差分): 乱数入力 6 万件で旧正規表現と抽出（位置と文字列）が一致する', () => {
  let s0 = 20261117 >>> 0;
  const rng = () => { s0 = (Math.imul(s0, 1664525) + 1013904223) >>> 0; return s0 / 4294967296; };
  const alphabet = [...'abcXYZ', ...'ABDe', ...'019', '_', '.', '/', '-', ' ', 'あ', '日', '"', "'", ':'];
  let mismatches = 0;
  let first = null;
  for (let n = 0; n < 60000; n++) {
    const len = Math.floor(rng() * 24);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
    const a = JSON.stringify(extract(IDENTS_OLD, s));
    const b = JSON.stringify(extract(IDENTS_NEW, s));
    if (a !== b) { mismatches++; if (!first) first = { s, a, b }; }
  }
  assert.equal(mismatches, 0, `不一致 ${mismatches} 件。最初の例: ${JSON.stringify(first)}`);
});
