import test from 'node:test';
import assert from 'node:assert/strict';

import { verify } from '../src/verify/gate.js';
import { envelopeSchema } from '../src/tasks/index.js';
import { renderMarkdown } from '../src/report/render.js';

// 検証ゲートの抜け道（item 単位のスキーマ検査・大文字の確度・空白引用・矛盾/next_actions の不正 ID・
// summary の推測語・citedEvidence・引用元の未引用・JSON なし）を塞いだことを確かめる。外部通信は行わない。

const schema = envelopeSchema(['spec']);
const pack = { items: [{ id: 'E1', text: 'hello world 設定' }, { id: 'E2', text: 'second' }] };
const policy = {
  requireCitations: true,
  requireVerbatimQuote: true,
  forbidSpeculativeLanguage: true,
  dropUnverifiedItems: true,
  minEvidencePerItem: 1,
};

const goodItem = (extra = {}) => ({
  id: 'I1', type: 'spec', title: 't', statement: 's', evidence: ['E1'], confidence: 'low', ...extra,
});
const envelope = (items, top = {}) => ({ summary: 's', open_questions: [], items, ...top });
const run = (result) => verify(result, { pack, schema, policy, taskId: 'spec' });
const codes = (v) => v.violations.map((x) => x.code);

test('verify(回帰): 正しい item・引用・contradiction・next_actions は ok のまま、違反なし', () => {
  const v = run(envelope(
    [goodItem({ quotes: [{ evidence: 'E1', text: 'hello world' }], confidence: 'high' })],
    { contradictions: [{ description: 'd', evidence: ['E1', 'E2'] }], next_actions: [{ action: 'a', evidence: ['E2'] }] },
  ));
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.deepEqual(v.violations, []);
  assert.equal(v.cleaned.items.length, 1);
  assert.equal(v.cleaned.contradictions.length, 1);
  assert.deepEqual(v.cleaned.next_actions[0].evidence, ['E2']);
  assert.deepEqual(v.cleaned._rejected, []);
  assert.equal(v.stats.citedEvidence, 1);
});

test('(1) スキーマ違反の item（statement なし・type/confidence が範囲外）は棄却され _rejected に E_SCHEMA が残る', () => {
  const bad = { id: 'I1', type: 'foo', title: 't', evidence: ['E1'], confidence: 'certain' };
  const v = run(envelope([bad]));
  assert.equal(v.stats.itemsAccepted, 0);
  assert.equal(v.stats.itemsRejected, 1);
  assert.equal(v.cleaned.items.length, 0);
  assert.equal(v.cleaned._rejected.length, 1);
  assert.ok(v.cleaned._rejected[0].reasons.some((r) => r.startsWith('E_SCHEMA') && r.includes('statement')));
});

test('(1) item のスキーマ違反メッセージは violations に二重に出ない', () => {
  const bad = { id: 'I1', type: 'foo', title: 't', evidence: ['E1'], confidence: 'certain' };
  const v = run(envelope([bad]));
  const msgs = v.violations.filter((x) => x.code === 'E_SCHEMA').map((x) => x.message);
  assert.equal(new Set(msgs).size, msgs.length, `重複: ${JSON.stringify(msgs)}`);
  assert.equal(v.ok, false);
});

test('(2) confidence が High / HIGH で推測語を含む item は E_SPECULATION で棄却される（high は従来どおり）', () => {
  for (const c of ['high', 'High', 'HIGH']) {
    const v = run(envelope([goodItem({ statement: 'おそらくキャッシュされる', confidence: c })]));
    // スキーマ違反（enum 外）が同時に出てもよいが、E_SPECULATION が必ず出ること
    assert.ok(codes(v).includes('E_SPECULATION'), `${c}: ${JSON.stringify(codes(v))}`);
    assert.equal(v.cleaned.items.length, 0, c);
  }
});

test('(3) 空白だけ・空の引用は失敗として数えられ、item は棄却される', () => {
  for (const text of ['   ', '', '\t\n ']) {
    const v = run(envelope([goodItem({ quotes: [{ evidence: 'E1', text }] })]));
    assert.equal(v.stats.quotesChecked, 1, JSON.stringify(text));
    assert.equal(v.stats.quotesFailed, 1, JSON.stringify(text));
    assert.equal(v.cleaned.items.length, 0, JSON.stringify(text));
    assert.equal(v.ok, false);
  }
});

test('(3) 空引用の違反には fixHint が付く', () => {
  const v = run(envelope([goodItem({ quotes: [{ evidence: 'E1', text: '   ' }] })]));
  const hit = v.violations.filter((x) => x.code === 'E_QUOTE_EMPTY');
  assert.equal(hit.length, 1, JSON.stringify(codes(v)));
  assert.ok(hit[0].fixHint);
});

test('(4) 存在しない証拠 ID を持つ contradictions は cleaned から外れ、_rejected に記録される（render が表示できる形）', () => {
  const v = run(envelope([goodItem()], {
    contradictions: [
      { description: '存在しない矛盾', evidence: ['E777'] },
      { description: '正しい矛盾', evidence: ['E1'] },
    ],
  }));
  assert.ok(codes(v).includes('E_BAD_EVIDENCE'));
  assert.equal(v.ok, false);
  assert.deepEqual(v.cleaned.contradictions.map((c) => c.description), ['正しい矛盾']);
  const rej = v.cleaned._rejected.filter((r) => r.kind === 'contradiction');
  assert.equal(rej.length, 1);
  assert.ok(rej[0].item.title.includes('存在しない矛盾'));
  assert.ok(rej[0].reasons.some((r) => r.includes('E777')));
  assert.equal(v.stats.itemsRejected, 0, 'item の棄却数には数えない');
});

test('(4) next_actions の不正な ID だけが落ち、要素は残る（W_BAD_EVIDENCE は変わらない）', () => {
  const v = run(envelope([goodItem()], { next_actions: [{ action: 'a', rationale: 'r', evidence: ['E1', 'E777'] }] }));
  assert.ok(codes(v).includes('W_BAD_EVIDENCE'));
  assert.equal(v.cleaned.next_actions.length, 1);
  assert.deepEqual(v.cleaned.next_actions[0].evidence, ['E1']);
  assert.equal(v.cleaned.next_actions[0].action, 'a');
});

test('(5) summary の推測語は W_SPECULATION（where は $.summary）で、ok は変わらない', () => {
  const v = run(envelope([goodItem()], { summary: 'おそらく設定が原因と思われる' }));
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  const hit = v.violations.filter((x) => x.code === 'W_SPECULATION' && x.where === '$.summary');
  assert.equal(hit.length, 1, JSON.stringify(v.violations));
  assert.equal(v.cleaned.items.length, 1);
});

test('(6) 採用 0 件なら citedEvidence は 0（棄却された item の証拠を数えない）', () => {
  const v = run(envelope([goodItem({ statement: 'おそらくそうだ', confidence: 'high' })]));
  assert.equal(v.stats.itemsAccepted, 0);
  assert.equal(v.stats.citedEvidence, 0);
});

test('(6) citedEvidence は採用された item の証拠だけ', () => {
  const v = run(envelope([
    goodItem(),
    goodItem({ id: 'I2', evidence: ['E2'], statement: 'おそらくそうだ', confidence: 'high' }),
  ]));
  assert.equal(v.stats.itemsAccepted, 1);
  assert.equal(v.stats.citedEvidence, 1);
});

test('(7) item の evidence に無い証拠からの引用は E_QUOTE_NOT_CITED で棄却される', () => {
  const v = run(envelope([goodItem({ evidence: ['E1'], quotes: [{ evidence: 'E2', text: 'second' }] })]));
  const hit = v.violations.filter((x) => x.code === 'E_QUOTE_NOT_CITED');
  assert.equal(hit.length, 1, JSON.stringify(codes(v)));
  assert.ok(hit[0].fixHint);
  assert.equal(v.cleaned.items.length, 0);
});

test('(7) evidence が空の item では E_QUOTE_NOT_CITED を重ねて出さない（E_NO_EVIDENCE のみ）', () => {
  const v = run(envelope([goodItem({ evidence: [], quotes: [{ evidence: 'E1', text: 'hello' }] })]));
  assert.ok(codes(v).includes('E_NO_EVIDENCE'));
  assert.ok(!codes(v).includes('E_QUOTE_NOT_CITED'), JSON.stringify(codes(v)));
});

test('(8) JSON が無い応答でも throw せず、cleaned は空の envelope・stats は 0 で埋まる', () => {
  const zeroStats = {
    itemsTotal: 0, itemsAccepted: 0, itemsRejected: 0, quotesChecked: 0, quotesFailed: 0,
    hardViolations: 1, softViolations: 0, citedEvidence: 0, evidenceOffered: 2,
  };
  for (const input of [null, undefined, 'x']) {
    let v;
    assert.doesNotThrow(() => { v = run(input); });
    assert.equal(v.ok, false);
    assert.deepEqual(codes(v), ['E_NO_JSON']);
    assert.deepEqual(v.cleaned, { summary: '', items: [], open_questions: [], contradictions: [], next_actions: [], _rejected: [] });
    assert.deepEqual(v.stats, zeroStats);
  }
});

test('(8) JSON が無い応答の結果を renderMarkdown に通しても落ちない', () => {
  const v = run(null);
  const md = renderMarkdown({
    task: { id: 'spec', label: '仕様整理' },
    instruction: 'i',
    result: v.cleaned,
    pack: { items: pack.items.map((e) => ({ ...e, label: e.id, sourceId: 's', path: 'p', kind: 'doc' })), tokens: 1, droppedCount: 0 },
    verification: v,
    meta: {
      startedAt: '', project: 'p', effort: 'normal', provider: 'x', model: 'm', promptHash: 'h', indexKey: 'k', indexChunks: 0,
      queries: [], usage: { input: 0, cacheRead: 0, output: 0 }, repairs: 0,
    },
  });
  assert.ok(md.includes('# 仕様整理'));
});
