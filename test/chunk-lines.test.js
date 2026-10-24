import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocument } from '../src/index/chunk.js';
import { buildEvidencePack } from '../src/index/pack.js';

// チャンクの行番号が実ファイルと一致すること、隣接チャンクの結合で行の途中が欠けないことの確認。
// 外部通信なし。

function docOf(kind, path, text) {
  return {
    docId: `d:${path}`, sourceId: 's', sourceType: 'local', path, title: path,
    kind, lang: kind === 'code' ? 'javascript' : 'markdown', url: '', version: 'v', meta: {}, text,
  };
}

function cfgOf(maxChars, overlapChars) {
  return { doc: { maxChars, overlapChars }, code: { maxLines: 40, overlapLines: 5, maxChars: 100000 } };
}

// 空行も見出しも無い、日本語の長い節（各行に固有のマーカーを含む）
function longSectionLines(n, pad = 6) {
  return Array.from({ length: n }, (_, i) => `これは仕様の第${i + 1}行です。${'決済の再試行は上限まで行う。'.repeat(pad)}LINEMARK${i + 1}END`);
}

// chunkDocument の結果を、検索結果と同じ形（score 付き）にして pack の結合に通す
function packOf(chunks) {
  return buildEvidencePack(chunks.map((c, i) => ({ ...c, score: 1 - i * 0.001 })), { budgetTokens: 10_000_000, maxItems: 1000 }).items;
}

const sliceLines = (lines, s, e) => lines.slice(s - 1, e).join('\n');

for (const [maxChars, overlap] of [[300, 60], [500, 100], [700, 0], [1000, 220], [2200, 220]]) {
  test(`pack の結合: 空行の無い 60 行の節で、結合後の本文が実ファイルの start〜end 行と一致し全行のマーカーが残る (maxChars=${maxChars}, overlap=${overlap})`, () => {
    const lines = longSectionLines(60);
    const chunks = chunkDocument(docOf('doc', 'long-spec.md', lines.join('\n')), cfgOf(maxChars, overlap));
    assert.ok(chunks.length > 1, '複数チャンクに分かれる前提');
    const items = packOf(chunks);
    for (const it of items) {
      assert.equal(it.text, sliceLines(lines, it.start, it.end), `${it.id} (${it.start}-${it.end}) が実ファイルの行と一致しない`);
    }
    const all = items.map((it) => it.text).join('\n');
    for (let n = 1; n <= 60; n++) assert.ok(all.includes(`LINEMARK${n}END`), `LINEMARK${n}END が欠けた`);
  });
}

test('チャンク: 文字数分割の位置は行頭に揃う（行の途中で切れたチャンクが無い）', () => {
  const lines = longSectionLines(60);
  const chunks = chunkDocument(docOf('doc', 'long-spec.md', lines.join('\n')), cfgOf(500, 100));
  for (const c of chunks) {
    assert.equal(c.text, sliceLines(lines, c.start, c.end), `${c.id} が行の途中で始まる／終わる`);
  }
});

test('チャンク: 取りこぼしなし（全行が少なくとも 1 つのチャンクに含まれる）', () => {
  const lines = longSectionLines(60);
  for (const [m, o] of [[300, 60], [500, 100], [700, 0], [2200, 220]]) {
    const chunks = chunkDocument(docOf('doc', 'long-spec.md', lines.join('\n')), cfgOf(m, o));
    for (let n = 1; n <= 60; n++) {
      assert.ok(chunks.some((c) => c.start <= n && n <= c.end && c.text.includes(`LINEMARK${n}END`)), `行 ${n} がどのチャンクにも無い (maxChars=${m})`);
    }
  }
});

test('末尾が改行のファイル: 最後のチャンクの end が実際の行数になる（doc / code）', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `行 ${i + 1}`);
  for (const kind of ['doc', 'code']) {
    const chunks = chunkDocument(docOf(kind, kind === 'doc' ? 'a.md' : 'a.js', lines.join('\n') + '\n'), cfgOf(2200, 220));
    assert.equal(chunks[chunks.length - 1].end, 12, `${kind}: 末尾の改行を行として数えている`);
    assert.equal(chunks[chunks.length - 1].text, lines.join('\n'));
  }
});

test('末尾が改行のファイル（長い節で分割される場合）も end が実際の行数になる', () => {
  const lines = longSectionLines(60);
  const chunks = chunkDocument(docOf('doc', 'long-spec.md', lines.join('\n') + '\n'), cfgOf(500, 100));
  assert.ok(chunks.length > 1);
  assert.equal(chunks[chunks.length - 1].end, 60);
});

test('末尾に改行が無いファイル（回帰ガード）: end が行数と一致する', () => {
  const lines = ['一行目', '二行目', '三行目'];
  for (const kind of ['doc', 'code']) {
    const chunks = chunkDocument(docOf(kind, kind === 'doc' ? 'b.md' : 'b.js', lines.join('\n')), cfgOf(2200, 220));
    assert.equal(chunks[chunks.length - 1].end, 3);
  }
});

test('1 行が maxChars を超える文書（改行なし）: 結合後の本文が実ファイルの行と一致し、行の途中の断片は結合されず残る', () => {
  const longLine = Array.from({ length: 80 }, (_, i) => `SEG${String(i).padStart(3, '0')}-決済の再試行は上限まで行う。`).join('');
  const lines = ['前の行', longLine, '後の行'];
  const chunks = chunkDocument(docOf('doc', 'one-line.md', lines.join('\n')), cfgOf(300, 40));
  assert.ok(chunks.length > 3, '1 行が複数チャンクに切られる前提');
  const items = packOf(chunks);
  for (const it of items) {
    const whole = sliceLines(lines, it.start, it.end);
    // 実ファイルの行と一致するか、行の途中の断片（実ファイルの該当行に含まれる部分文字列）であること
    assert.ok(it.text === whole || whole.includes(it.text), `${it.id} (${it.start}-${it.end}) が実ファイルと食い違う`);
  }
  // 断片を含め、長い行の全セグメントがどこかの item に残る
  const all = items.map((it) => it.text).join('\n');
  for (let i = 0; i < 80; i++) assert.ok(all.includes(`SEG${String(i).padStart(3, '0')}-`), `SEG${i} が欠けた`);
});

test('1 行が maxChars を超え、断片の中身が同一でも（同じ文字の繰り返し）断片は落とされない', () => {
  const lines = ['前の行', 'x'.repeat(1000), '後の行'];
  const chunks = chunkDocument(docOf('doc', 'xs.md', lines.join('\n')), cfgOf(300, 0));
  const items = packOf(chunks);
  const xs = items.map((it) => it.text).join('\n').split('').filter((ch) => ch === 'x').length;
  assert.ok(xs >= 1000, `x が ${xs} 個しか残らない（断片が結合で落ちた）`);
});

test('pack: 重なりの行が一致しないチャンクは、黙って後ろを切り落とさず別 item にする（旧索引の行の途中のチャンク）', () => {
  const mk = (start, end, text, score) => ({ docId: 'd:x', sourceId: 's', sourceType: 'local', kind: 'doc', path: 'x.md', title: 'x', version: 'v', url: '', start, end, text, score });
  // 38 行目の前半（A）と、同じ 38 行目の後半（B）。行番号は重なるが本文は同じ行の別の部分
  const a = mk(1, 38, 'l1\nl2\nHEAD-of-38', 1);
  const b = mk(38, 40, 'TAIL-of-38\nl39\nl40', 0.9);
  const items = buildEvidencePack([a, b], { budgetTokens: 10_000_000 }).items;
  const all = items.map((it) => it.text).join('\n');
  assert.ok(all.includes('TAIL-of-38'), '行の後半が欠けた');
  assert.ok(all.includes('HEAD-of-38'));
});

test('pack: 行単位で正しく重なるチャンクは従来どおり 1 つに結合される（回帰ガード）', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
  const mk = (start, end, score) => ({ docId: 'd:x', sourceId: 's', sourceType: 'local', kind: 'doc', path: 'x.md', title: 'x', version: 'v', url: '', start, end, text: sliceLines(lines, start, end), score });
  const items = buildEvidencePack([mk(1, 6, 1), mk(5, 10, 0.5)], { budgetTokens: 10_000_000 }).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].text, lines.join('\n'));
  assert.deepEqual([items[0].start, items[0].end], [1, 10]);
});
