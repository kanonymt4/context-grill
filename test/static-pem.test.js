import test from 'node:test';
import assert from 'node:assert/strict';

import { scanAll, renderStaticFacts } from '../src/analysis/static.js';
import { redactText } from '../src/util/redact.js';

// 静的解析の snippet / context に PEM 秘密鍵の本文が出ないことの回帰テスト。
// 鍵の本文には固有のマーカー文字列（MARK）を入れ、出力のどこにも現れないことを見る。

const MARK = 'ZqXkeyBODYmarker';

function doc(text, p = 'src/app.js') {
  return { kind: 'code', lang: 'js', path: p, sourceId: 'repo', sourceType: 'local', url: null, text };
}

function allOutputs(findings) {
  const facts = renderStaticFacts({ findings }, 100000);
  return JSON.stringify(findings) + '\n' + facts;
}

test('静的解析: 複数行 PEM の END 直後の検出で、context に鍵本文が出ない', () => {
  const body = Array.from({ length: 20 }, (_, i) => `${MARK}${i}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
  const text = [
    'const key = `',
    '-----BEGIN PRIVATE KEY-----',
    ...body,
    '-----END PRIVATE KEY-----`;',
    'const agent = { rejectUnauthorized: false };',
  ].join('\n');
  const findings = scanAll([doc(text)]);
  const f = findings.find((x) => x.ruleId === 'SEC-TLS-DISABLED');
  assert.ok(f, 'TLS 無効化が検出されること');
  assert.equal(f.line, 24, '行番号は元の行のまま');
  assert.ok(!allOutputs(findings).includes(MARK), '鍵本文が出力に含まれている');
  assert.ok(f.snippet.includes('rejectUnauthorized'), '検出行の snippet は残る');
});

test('静的解析: 1 行形式の長い JSON（END が 300 字より後）でも snippet / context に鍵本文が出ない', () => {
  const key = `-----BEGIN PRIVATE KEY-----\\n${(MARK + 'A').repeat(150)}\\n-----END PRIVATE KEY-----\\n`;
  const text = `const sa = { "private_key": "${key}", agent: { rejectUnauthorized: false } };`;
  const findings = scanAll([doc(text)]);
  assert.ok(findings.some((x) => x.ruleId === 'SEC-TLS-DISABLED'));
  assert.ok(!allOutputs(findings).includes(MARK), '鍵本文が出力に含まれている');
});

test('静的解析: 2 行に分けた文字列連結の鍵でも本文が出ない', () => {
  const text = [
    `const k = "-----BEGIN PRIVATE KEY-----" +`,
    `  "${MARK}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +`,
    `  "-----END PRIVATE KEY-----"; const a = { rejectUnauthorized: false };`,
  ].join('\n');
  const findings = scanAll([doc(text)]);
  assert.ok(findings.length > 0);
  assert.ok(!allOutputs(findings).includes(MARK), '鍵本文が出力に含まれている');
});

test('redactText: END だけの行は END より前（本文の続き）を伏せ、後ろを残す', () => {
  const r = redactText(`${MARK}AAAA-----END PRIVATE KEY----- tail`);
  assert.ok(!r.text.includes(MARK));
  assert.ok(r.text.includes('tail'));
});

test('redactText: 同じ行に END が無い BEGIN は、BEGIN 以降の本文を出さず前の部分を残す', () => {
  const r = redactText(`head "-----BEGIN PRIVATE KEY-----\\n${MARK}AAAA`);
  assert.ok(!r.text.includes(MARK));
  assert.ok(r.text.startsWith('head "'));
  assert.equal(r.text.split('\n').length, 1);
});

test('回帰ガード: 鍵を含まない通常の検出の snippet / context は変わらない', () => {
  const text = ['line1', 'line2', 'const a = { rejectUnauthorized: false };', 'line4', 'line5'].join('\n');
  const [f] = scanAll([doc(text)]);
  assert.equal(f.snippet, 'const a = { rejectUnauthorized: false };');
  assert.equal(f.context, text);
});

test('回帰ガード: 公開鍵・証明書は伏せない', () => {
  const text = [
    '-----BEGIN PUBLIC KEY-----',
    `${MARK}PUBAAAA`,
    '-----END PUBLIC KEY-----',
    'const a = { rejectUnauthorized: false };',
  ].join('\n');
  const [f] = scanAll([doc(text)]);
  assert.ok(f.context.includes(`${MARK}PUBAAAA`));
});
