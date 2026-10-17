import test from 'node:test';
import assert from 'node:assert/strict';

import { verify } from '../src/verify/gate.js';
import { validate } from '../src/llm/jsonschema.js';
import { envelopeSchema, TASKS } from '../src/tasks/index.js';

// 型の合わない入力で verify() が生の TypeError を投げず、違反として返すことを確かめる。
// 外部通信は行わない。

const schema = envelopeSchema(TASKS.spec.itemTypes);
const pack = { items: [{ id: 'E1', label: 'repo/a.js:1-3', text: 'hello' }] };
const policy = {
  requireCitations: true,
  requireVerbatimQuote: true,
  forbidSpeculativeLanguage: true,
  dropUnverifiedItems: true,
  minEvidencePerItem: 1,
};

const goodItem = () => ({
  id: 'I1', type: 'requirement', title: 't', statement: 's', evidence: ['E1'], confidence: 'low',
});
const make = (itemExtra = {}, top = {}) => ({
  summary: 's',
  open_questions: [],
  items: [{ ...goodItem(), ...itemExtra }],
  ...top,
});
const run = (result) => verify(result, { pack, schema, policy, taskId: 'spec' });

// where: 違反の where に含まれるべき文字列、message: 違反メッセージ（厳密一致）
const MALFORMED = [
  ['quotes={}', make({ quotes: {} }), 'items[0]', 'quotes は配列である必要があります'],
  ['quotes=5', make({ quotes: 5 }), 'items[0]', 'quotes は配列である必要があります'],
  ['quotes=[null]', make({ quotes: [null] }), 'items[0]', 'quotes[0] がオブジェクトではありません'],
  ['quotes=[5]', make({ quotes: [5] }), 'items[0]', 'quotes[0] がオブジェクトではありません'],
  ['contradicting_evidence=5', make({ contradicting_evidence: 5 }), 'items[0]', 'contradicting_evidence は配列である必要があります'],
  ['contradictions={}', make({}, { contradictions: {} }), '$.contradictions', 'contradictions は配列である必要があります'],
  ['contradictions=[null]', make({}, { contradictions: [null] }), 'contradictions[0]', 'contradictions[0] がオブジェクトではありません'],
  ['contradictions=[{evidence:5}]', make({}, { contradictions: [{ description: 'd', evidence: 5 }] }), 'contradictions[0]', 'contradictions[0].evidence は配列である必要があります'],
  ['next_actions=[null]', make({}, { next_actions: [null] }), 'next_actions[0]', 'next_actions[0] がオブジェクトではありません'],
  ['next_actions="x"', make({}, { next_actions: 'x' }), '$.next_actions', 'next_actions は配列である必要があります'],
];

for (const [name, input, where, message] of MALFORMED) {
  test(`verify: ${name} は throw せず E_SCHEMA のハード違反になる`, () => {
    let v;
    assert.doesNotThrow(() => { v = run(input); });
    assert.equal(v.ok, false);
    const hit = v.violations.filter((x) => x.code === 'E_SCHEMA' && x.where.includes(where) && x.message === message);
    assert.equal(hit.length, 1, `該当する E_SCHEMA が 1 件ありません: ${JSON.stringify(v.violations)}`);
  });
}

test('verify: quotes / contradicting_evidence の型違反を持つ item は棄却される', () => {
  for (const extra of [{ quotes: {} }, { quotes: [null] }, { contradicting_evidence: 5 }]) {
    const v = run(make(extra));
    assert.equal(v.stats.itemsRejected, 1);
    assert.equal(v.cleaned.items.length, 0);
  }
});

test('verify: オブジェクトでない quotes 要素は quotesChecked / quotesFailed に数えず、他の要素は検査する', () => {
  const v = run(make({ quotes: [null, { evidence: 'E1', text: 'hello' }, { evidence: 'E1', text: 'nope' }] }));
  assert.equal(v.stats.quotesChecked, 2);
  assert.equal(v.stats.quotesFailed, 1);
  assert.ok(v.violations.some((x) => x.code === 'E_SCHEMA' && x.message === 'quotes[0] がオブジェクトではありません'));
  assert.ok(v.violations.some((x) => x.code === 'E_QUOTE_MISMATCH'));
});

test('verify: 型違反の contradictions 要素はスキップし、他の要素は従来どおり検査する', () => {
  const v = run(make({}, { contradictions: [null, { description: 'd', evidence: ['E9'] }] }));
  assert.ok(v.violations.some((x) => x.code === 'E_SCHEMA' && x.where === 'contradictions[0]'));
  assert.ok(v.violations.some((x) => x.code === 'E_BAD_EVIDENCE' && x.where === 'contradictions[1]'));
});

test('verify(回帰): 正常な quotes / contradictions / next_actions は ok のまま', () => {
  const v = run(make(
    { quotes: [{ evidence: 'E1', text: 'hello' }], contradicting_evidence: ['E1'] },
    {
      contradictions: [{ description: 'd', evidence: ['E1'] }],
      next_actions: [{ action: 'a', rationale: 'r', evidence: ['E1'] }],
    },
  ));
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.deepEqual(v.violations, []);
  assert.equal(v.stats.quotesChecked, 1);
  assert.equal(v.stats.quotesFailed, 0);
});

test('verify(回帰): evidence が文字列・result が配列のときは従来どおり E_SCHEMA で返る', () => {
  const v1 = run(make({ evidence: 'E1' }));
  assert.equal(v1.ok, false);
  assert.ok(v1.violations.some((x) => x.code === 'E_SCHEMA' && x.where === '$'));
  const v2 = run([]);
  assert.equal(v2.ok, false);
  assert.ok(v2.violations.some((x) => x.code === 'E_SCHEMA' && x.where === '$'));
});

test('jsonschema: 子の違反が数万件でも RangeError にならずエラー配列を返す', () => {
  const N = 40000;
  // 空の item 1 件につき必須項目 6 件の違反が出る（配列のスプレッドが引数の上限を超える規模）
  const input = { summary: 's', open_questions: [], items: Array.from({ length: N }, () => ({})) };
  let errs;
  assert.doesNotThrow(() => { errs = validate(schema, input); });
  assert.equal(errs.length, N * 6);
  assert.equal(errs[0], '$.items[0].id: 必須項目がありません');
  assert.equal(errs[errs.length - 1], `$.items[${N - 1}].confidence: 必須項目がありません`);
});

test('jsonschema: プロパティ経由の子の違反が数万件でも RangeError にならない', () => {
  const N = 40000;
  const schema2 = { type: 'object', properties: { list: { type: 'array', items: { type: 'object', required: ['a', 'b', 'c', 'd', 'e', 'f'] } } } };
  let errs;
  assert.doesNotThrow(() => { errs = validate(schema2, { list: Array.from({ length: N }, () => ({})) }); });
  assert.equal(errs.length, N * 6);
});
