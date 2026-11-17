// htmlToText の、コードブロックの保全と実体参照の復号（1 回だけ・名前付き・16 進の大文字 X）の確認。
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, HTML_TEXT_VERSION } from '../src/util/html.js';
import { toDoc } from '../src/connectors/confluence.js';

const macro = (code, name = 'code') =>
  `<ac:structured-macro ac:name="${name}"><ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`;

test('コードマクロ内の実体参照は復号して残す（比較演算子・ジェネリクス）', () => {
  assert.equal(htmlToText(macro('if (a&lt;b &amp;&amp; c&gt;d) {')), '```\nif (a<b && c>d) {\n```');
  assert.equal(htmlToText(macro('Map&lt;String, Integer&gt; m')), '```\nMap<String, Integer> m\n```');
  assert.equal(htmlToText(macro('List&lt;Order&gt; xs')), '```\nList<Order> xs\n```');
});

test('コードマクロ内の字下げと連続する空白行を保つ（YAML の階層）', () => {
  const yaml = 'retry:\n  max: 3\n  backoff:\n    base: 200';
  assert.equal(htmlToText(macro(yaml)), '```\n' + yaml + '\n```');
  const gap = 'a\n\n\n\n  b   ';
  assert.equal(htmlToText(macro(gap)), '```\n' + gap + '\n```');
});

test('コードマクロ内のタグ風の文字列は除去しない', () => {
  assert.equal(htmlToText(macro('<div class="x">hi</div>')), '```\n<div class="x">hi</div>\n```');
});

test('単独の plain-text-body も字下げを保つ', () => {
  assert.equal(
    htmlToText('<ac:plain-text-body><![CDATA[x:\n    y: 1]]></ac:plain-text-body>'),
    'x:\n    y: 1',
  );
});

test('<pre> 内の字下げを保ち、中のタグは除去して実体参照は復号する', () => {
  assert.equal(
    htmlToText('<pre>def f():\n    if a &lt; b:\n        return 1</pre>'),
    'def f():\n    if a < b:\n        return 1',
  );
  assert.equal(
    htmlToText('<p>前</p><pre class="x"><span>a</span><span>b</span>\n  <br/>c</pre><p>後</p>'),
    '前\n\nab\n  \nc\n\n後',
  );
});

test('<pre> の外の字下げ・空白の圧縮は従来どおり（対照）', () => {
  assert.equal(htmlToText('<p>a    b</p>\n<p>  c</p>'), 'a b\n\n c');
});

test('実体参照は 1 回だけ復号する（二重復号しない）', () => {
  assert.equal(htmlToText('<p>&amp;lt;div&amp;gt;</p>'), '&lt;div&gt;');
  assert.equal(htmlToText(macro('&amp;lt;div&amp;gt;')), '```\n&lt;div&gt;\n```');
  assert.equal(htmlToText('<p>&amp;amp;</p>'), '&amp;');
});

test('名前付き実体参照を復号する', () => {
  const cases = {
    '&rsquo;': '\u2019', '&lsquo;': '\u2018', '&ldquo;': '\u201C', '&rdquo;': '\u201D',
    '&ndash;': '\u2013', '&mdash;': '\u2014', '&hellip;': '\u2026', '&rarr;': '\u2192',
    '&larr;': '\u2190', '&apos;': "'", '&yen;': '\u00A5', '&le;': '\u2264', '&ge;': '\u2265',
    '&ne;': '\u2260', '&times;': '\u00D7', '&copy;': '\u00A9', '&reg;': '\u00AE',
    '&trade;': '\u2122', '&middot;': '\u00B7', '&laquo;': '\u00AB', '&raquo;': '\u00BB',
    '&quot;': '"', '&nbsp;': ' ',
  };
  for (const [ent, ch] of Object.entries(cases)) {
    assert.equal(htmlToText(`<p>x${ent}y</p>`), `x${ch}y`, ent);
  }
  // 表に無い名前は、そのまま残す
  assert.equal(htmlToText('<p>&unknownentity; &amp</p>'), '&unknownentity; &amp');
});

test('数値参照: &#x / &#X を 16 進、&#N を 10 進として扱う', () => {
  assert.equal(htmlToText('<p>&#X41;&#x42;&#67;&#x1F600;</p>'), 'ABC\u{1F600}');
  // 範囲外・不正はそのまま
  assert.equal(htmlToText('<p>&#x110000;</p>'), '&#x110000;');
});

test('本文に番兵と同じ文字列があっても壊れない', () => {
  // 退避の番兵は \uE000 と \uE001 を使うので、本文にそれらや番兵に似た列が現れるケースを入れる
  const fake = '\uE000cg0_0\uE001 \uE000cg1_0\uE001 \uE000 \uE001';
  const out = htmlToText(`<p>${fake}</p>${macro('code1')}<p>&#xE000;cg0_0&#xE001;</p>${macro('code2')}`);
  assert.ok(out.startsWith(fake), out);
  assert.ok(out.includes('```\ncode1\n```'), out);
  assert.ok(out.includes('```\ncode2\n```'), out);
  assert.ok(out.includes('&#xE000;cg0_0&#xE001;'), out);
});

test('時間: 閉じない <pre の繰り返しが 500ms 未満で終わる', () => {
  for (const html of ['<pre>'.repeat(80000), '<pre '.repeat(80000)]) {
    const t = performance.now();
    htmlToText(html);
    const ms = performance.now() - t;
    assert.ok(ms < 500, `${ms.toFixed(0)}ms かかった`);
  }
});

// Confluence: 変換の版が変わったら、版番号が同じでもキャッシュした本文を使わない
const page = { id: '1', title: 'T', version: { number: 3 }, body: { storage: { value: macro('a&lt;b') } } };
const src = { id: 'c1', spaceKey: 'S' };

test('toDoc: キャッシュに変換の版が無い（旧版）ときは、ページ版が同じでも再変換する', () => {
  const key = 'c1:pages/1';
  const stale = { docId: key, version: '3', text: '# T\n\n```\na\n```', meta: {} };
  const d = toDoc(src, 'https://x', page, new Map([[key, stale]]));
  assert.ok(d.text.includes('a<b'), d.text);
  assert.equal(d.meta.textVersion, HTML_TEXT_VERSION);
});

test('toDoc: 変換の版もページ版も同じなら、キャッシュ本文を使う（対照）', () => {
  const key = 'c1:pages/1';
  const cached = { docId: key, version: '3', text: 'CACHED', meta: { textVersion: HTML_TEXT_VERSION } };
  const d = toDoc(src, 'https://x', page, new Map([[key, cached]]));
  assert.equal(d.text, 'CACHED');
});
