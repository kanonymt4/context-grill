import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocument, chunkCode, chunkText } from '../src/index/chunk.js';
import * as redact from '../src/util/redact.js';

// 実装前でも import で落ちず、アサーションで失敗させるため名前空間で受ける
const redactPemBlocks = (t) => redact.redactPemBlocks(t);

// PEM が文書単位で伏せられること（チャンク分割の前）と、チャンク分割の最悪入力の確認。
// 鍵はテスト内で生成したダミー。各行に固有のマーカーを含める。

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
const END = '-----END RSA PRIVATE KEY-----';
const MARK = 'ZZKEYBODY';

function pemLines(n = 50) {
  const out = [BEGIN];
  for (let i = 0; i < n; i++) out.push(`${MARK}${String(i).padStart(3, '0')}${'AbCd0123+/'.repeat(6)}`);
  out.push(END);
  return out;
}

const CFG = {
  doc: { maxChars: 600, overlapChars: 60 },
  code: { maxLines: 40, overlapLines: 5, maxChars: 100000 },
};

function docOf(kind, path, lines) {
  return {
    docId: `d:${path}`, sourceId: 's', sourceType: 'local', path, title: path,
    kind, lang: kind === 'code' ? 'python' : 'markdown', url: '', version: 'v', meta: {}, text: lines.join('\n'),
  };
}

function ranges(chunks) { return chunks.map((c) => [c.start, c.end]); }

test('chunkDocument: 文書の PEM が複数チャンクにまたがっても鍵の本文がどのチャンクにも残らない', () => {
  const lines = ['# 運用', '説明文', ''];
  lines.push(...pemLines(50));
  lines.push('', '末尾の文章');
  const doc = docOf('doc', 'docs/ops-keys.md', lines);
  // 前提: 伏せる前の本文は 2 チャンク以上に分かれ、2 つ目以降は BEGIN を含まない
  const raw = chunkText(doc, CFG.doc);
  assert.ok(raw.length >= 2 && raw.slice(1).some((c) => c.text.includes(MARK) && !c.text.includes('BEGIN')));
  const chunks = chunkDocument(doc, CFG);
  for (const c of chunks) assert.ok(!c.text.includes(MARK), `チャンク ${c.id} に鍵の本文が残っている`);
  // 鍵の外の文章は残る
  assert.ok(chunks.some((c) => c.text.includes('末尾の文章')));
});

test('chunkDocument: コード（宣言行なし）の PEM が 110 行目付近にあっても伏せられ、行番号は鍵が無い場合と同じ', () => {
  const body = [];
  for (let i = 0; i < 100; i++) body.push(`x${i} = ${i}`);
  const withKey = [...body, ...pemLines(50), 'tail = 1'];
  const doc = docOf('code', 'k.py', withKey);
  // 前提: 伏せる前は BEGIN の無いチャンクに鍵の本文が入る
  assert.ok(chunkCode(doc, CFG.code).some((c) => c.text.includes(MARK) && !c.text.includes('BEGIN')));
  const a = chunkDocument(doc, CFG);
  for (const c of a) assert.ok(!c.text.includes(MARK), `チャンク ${c.id} に鍵の本文が残っている`);
  // 行数が保たれる: 各チャンクの本文は、伏せた後の文書の start〜end 行と一致し、末尾の行番号も正しい
  const red = redactPemBlocks(doc.text).split('\n');
  assert.equal(red.length, withKey.length);
  for (const c of a) assert.equal(c.text, red.slice(c.start - 1, c.end).join('\n'), c.id);
  const last = a[a.length - 1];
  assert.equal(last.end, withKey.length);
  assert.ok(last.text.endsWith('tail = 1'));
  // 鍵を含まない先頭 3 チャンクの範囲は、鍵が無い文書と同じ
  const plain = chunkDocument(docOf('code', 'k.py', withKey.map((l, i) => (i >= 100 ? `y = ${i}` : l))), CFG);
  assert.deepEqual(ranges(a).slice(0, 3), ranges(plain).slice(0, 3));
});

test('redactPemBlocks: 行数を保ち、BEGIN 行に印を置いて残りは空行にする', () => {
  const lines = ['前', ...pemLines(3), '後'];
  const out = redactPemBlocks(lines.join('\n'));
  const o = out.split('\n');
  assert.equal(o.length, lines.length);
  assert.equal(o[0], '前');
  assert.equal(o[1], '«REDACTED:PRIVATE_KEY»');
  assert.deepEqual(o.slice(2, 6), ['', '', '', '']);
  assert.equal(o[o.length - 1], '後');
  assert.ok(!out.includes(MARK));
});

test('redactPemBlocks: 1 行形式（エスケープ \\n を含む）は伏せ、その行の前後の行は無傷', () => {
  const one = `key = "${BEGIN}\\n${MARK}AAAA\\n${END}" # tail`;
  const out = redactPemBlocks(['before line', one, 'after line'].join('\n')).split('\n');
  assert.equal(out.length, 3);
  assert.equal(out[0], 'before line');
  assert.equal(out[2], 'after line');
  assert.ok(!out[1].includes(MARK));
  assert.ok(out[1].includes('«REDACTED:PRIVATE_KEY»'));
  assert.ok(out[1].includes('# tail'), '同じ行の END より後ろは残る');
  // 実際の改行を含まない 1 行形式（スペース区切り）も
  const sp = `${BEGIN} ${MARK}BBBB ${END}`;
  assert.ok(!redactPemBlocks(`a\n${sp}\nb`).includes(MARK));
});

test('redactPemBlocks: END が無い BEGIN は文書の終わりまで伏せる', () => {
  const lines = ['head', BEGIN, `${MARK}1`, `${MARK}2`, '本文に見える行'];
  const out = redactPemBlocks(lines.join('\n')).split('\n');
  assert.equal(out.length, lines.length);
  assert.equal(out[0], 'head');
  assert.equal(out[1], '«REDACTED:PRIVATE_KEY»');
  assert.deepEqual(out.slice(2), ['', '', '']);
});

test('redactPemBlocks(回帰): 公開鍵・証明書は伏せない。鍵の終わりより後の行は残る', () => {
  const pub = ['-----BEGIN PUBLIC KEY-----', `${MARK}pub`, '-----END PUBLIC KEY-----'].join('\n');
  const cert = ['-----BEGIN CERTIFICATE-----', `${MARK}cert`, '-----END CERTIFICATE-----'].join('\n');
  assert.equal(redactPemBlocks(pub), pub);
  assert.equal(redactPemBlocks(cert), cert);
  const mixed = [...pemLines(2), 'after key'].join('\n').split('\n');
  assert.equal(redactPemBlocks(mixed.join('\n')).split('\n').pop(), 'after key');
  // OPENSSH / PGP / 汎用の PRIVATE KEY も対象
  for (const name of ['PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'EC PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
    const t = `-----BEGIN ${name}-----\n${MARK}\n-----END ${name}-----`;
    assert.ok(!redactPemBlocks(t).includes(MARK), name);
  }
});

test('chunkDocument: 1 行形式の PEM は伏せ、前後の行は無傷。END の無い BEGIN は以降が伏せられる', () => {
  const one = chunkDocument(docOf('doc', 'one.md', ['前の行', `k: ${BEGIN}\\n${MARK}1\\n${END}`, '後の行']), CFG);
  const t1 = one.map((c) => c.text).join('\n');
  assert.ok(!t1.includes(MARK) && t1.includes('前の行') && t1.includes('後の行'));
  const open = chunkDocument(docOf('doc', 'open.md', ['前の行', BEGIN, `${MARK}1`, `${MARK}2`, '切れた後ろの行']), CFG);
  const t2 = open.map((c) => c.text).join('\n');
  assert.ok(!t2.includes(MARK) && !t2.includes('切れた後ろの行') && t2.includes('前の行'));
});

test('chunkDocument(回帰): PEM を含まない文書のチャンクは変更前と同じ（固定した期待値）', () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(i % 20 === 0 ? `function f${i}() {` : `  body ${i};`);
  const code = chunkDocument(docOf('code', 'a.js', lines), CFG);
  assert.deepEqual(ranges(code), [[1, 40], [36, 60]]);
  const md = [];
  for (let i = 0; i < 40; i++) md.push(i % 10 === 0 ? `## 見出し${i}` : `文章 ${i} `.repeat(4));
  const docs = chunkDocument(docOf('doc', 'a.md', md), CFG);
  assert.deepEqual(ranges(docs), [[1, 10], [11, 20], [21, 30], [31, 40]]);
});

test('chunkDocument: 元の doc.text は書き換えない（キャッシュは元の本文のまま）', () => {
  const doc = docOf('doc', 'k.md', pemLines(5));
  const before = doc.text;
  chunkDocument(doc, CFG);
  assert.equal(doc.text, before);
});

test('chunkDocument: DECL_RE の最悪入力（export + 空白 200,000 個 + x）が 1000ms 未満', () => {
  const doc = docOf('code', 'w.js', ['export' + ' '.repeat(200000) + 'x']);
  const t0 = Date.now();
  const chunks = chunkDocument(doc, CFG);
  const ms = Date.now() - t0;
  assert.ok(chunks.length >= 1);
  assert.ok(ms < 1000, `${ms}ms`);
});

test('chunkDocument(回帰): 2000 字以下の宣言行は従来どおり境界になる', () => {
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(`  x ${i}`);
  lines[38] = 'export    async function target() {';
  const chunks = chunkDocument(docOf('code', 'd.js', lines), CFG);
  // maxLines=40 手前の宣言行（0 始まり 38）で切れる
  assert.equal(chunks[0].end, 38);
});
