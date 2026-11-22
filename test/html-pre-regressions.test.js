// #123 で入れた <pre> 退避と番兵が起こした回帰（pre 内の CDATA・リンク・メンション、番兵と本文の衝突）の確認。
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/util/html.js';

const macro = (code) =>
  `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`;

test('<pre> 内の CDATA の中身は、タグ除去の対象にしない', () => {
  assert.equal(htmlToText('<pre><![CDATA[a<b]]></pre>'), 'a<b');
  assert.equal(htmlToText('<pre>x <![CDATA[<i>y</i>]]> z</pre>'), 'x <i>y</i> z');
});

test('<pre> 外の CDATA は従来どおり中身だけになる（対照）', () => {
  assert.equal(htmlToText('<p><![CDATA[a<b]]></p>'), 'a<b');
});

test('<pre> 内の ac:link と ri:user も変換する', () => {
  assert.equal(
    htmlToText('<pre>see <ac:link><ri:page ri:content-title="Spec"/></ac:link> by <ri:user ri:account-id="u1"/></pre>'),
    'see [[Spec]] by @u1',
  );
});

test('<pre> 外の ac:link と ri:user の結果は変わらない（対照）', () => {
  assert.equal(
    htmlToText('<p>see <ac:link><ri:page ri:content-title="Spec"/></ac:link> by <ri:user ri:account-id="u1"/></p>'),
    'see [[Spec]] by @u1',
  );
});

test('通常の <pre> は字下げ・記号・内側のタグ除去を保つ（対照）', () => {
  assert.equal(
    htmlToText('<pre>def f():\n    if a &lt; b:\n  <span>x</span><br/>y</pre>'),
    'def f():\n    if a < b:\n  x\ny',
  );
});

test('入力に含まれる番兵の文字（U+E000 / U+E001）は、本文に残さない', () => {
  // 番兵の接頭辞（U+E000 + "cg0_"）の「_」を実体参照で書くと、復号前の衝突検査をすり抜ける
  const out = htmlToText(`<p>see cg0&#95;0 here</p>${macro('SECRET_CODE()')}`);
  assert.ok(out.includes('see cg0_0 here'), out);
  assert.equal(out.match(/SECRET_CODE\(\)/g).length, 1, out);
  assert.equal(htmlToText('<p>a\uE000b\uE001c</p>'), 'abc');
});

test('番兵の文字を含まない普通の入力の出力は変わらない（対照）', () => {
  assert.equal(htmlToText('<h2>見出し</h2><p>本文 cg0_0</p>'), '## 見出し\n\n本文 cg0_0');
  assert.equal(htmlToText(macro('a&lt;b')), '```\na<b\n```');
});
