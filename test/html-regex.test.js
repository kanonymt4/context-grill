// htmlToText の正規表現が、閉じないタグの繰り返しで二乗・三乗にならないことと、
// 通常の HTML の変換結果が変わらないことの確認。
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/util/html.js';

// Confluence ストレージ形式に近い入力。期待値は、修正前の実装の出力をそのまま固定したもの。
// ただし <pre> 内の字下げだけは意図した差分（修正前は 2 空白が 1 空白に潰れていた。コードの字下げを保つよう直した）
const FIXTURE = [
  '<h1 id="t">仕様書</h1>',
  '<p>担当: <ri:user ri:account-id="abc123"/> と <ri:user ri:userkey="k" ri:account-id="def456" /> が確認。</p>',
  '<p>属性なし: <ri:user ri:userkey="zzz"/> は account-id なし。</p>',
  '<p>参照 <a href="https://example.com/x?a=1&amp;b=2" class="x">リンク&nbsp;文字</a> と <br/> 改行 &lt;tag&gt; &#65; &#x42;</p>',
  '<ac:link><ri:page ri:content-title="設計メモ" ri:space-key="DOC"/><ac:plain-text-link-body><![CDATA[表示名]]></ac:plain-text-link-body></ac:link>',
  '<ac:structured-macro ac:name="code" ac:schema-version="1" ac:macro-id="m1"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[const a = 1 < 2;\nif (a) { run(); }]]></ac:plain-text-body></ac:structured-macro>',
  '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>注意書き</p></ac:rich-text-body></ac:structured-macro>',
  '<ul><li>項目1</li><li class="c">項目2<ul><li>入れ子</li></ul></li></ul>',
  '<ol><li>手順A</li><li>手順B</li></ol>',
  '<table class="wrapped"><thead><tr><th>列1</th><th>列2</th></tr></thead><tbody><tr><td>a</td><td>b <strong>太字</strong></td></tr><tr><td colspan="2">c</td></tr></tbody></table>',
  '<script>var x = "<b>";</script><style>p { color: red; }</style>',
  '<h2>見出し2</h2><h3 class="y">見出し3</h3>',
  '<pre>整形済み\n  テキスト</pre><blockquote>引用</blockquote>',
  '<p>末尾   空白   多い  \n\n\n\n段落</p>',
  '<!-- comment --><span>inline</span><em>強調</em>',
  '<ac:image><ri:attachment ri:filename="a.png"/></ac:image>',
  '<ri:user ri:account-id="xyz"></ri:user>',
  '<p>ネスト <ri:user ri:account-id="q&quot;r"/> 終わり</p>',
  '<ac:task-list><ac:task><ac:task-body>やること</ac:task-body></ac:task></ac:task-list>',
  '<p>最後の段落&amp;完了</p>',
].join('\n');

const EXPECTED = '# 仕様書\n\n担当: @abc123 と @def456 が確認。\n\n属性なし: は account-id なし。\n\n参照 リンク 文字 と\n 改行 <tag> A B\n\n[[設計メモ]]\n\n```\nconst a = 1 < 2;\nif (a) { run(); }\n```\n\n注意書き\n\n- 項目1\n\n- 項目2\n\n- 入れ子\n\n- 手順A\n\n- 手順B\n\n |\n | 列1 | 列2\n\n | a | b 太字\n\n | c\n\n## 見出し2\n\n### 見出し3\n\n整形済み\n  テキスト\n\n引用\n\n末尾 空白 多い\n\n段落\n\n<!-- comment --> inline 強調\n\nネスト @q"r 終わり\n\n やること\n\n最後の段落&完了';

function timeMs(fn) {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

test('htmlToText(回帰): 通常の Confluence 風 HTML の変換結果は修正前と完全に同じ', () => {
  assert.equal(htmlToText(FIXTURE), EXPECTED);
});

test('htmlToText: 閉じない <ri:user ri:account-id=" の繰り返し(約120KB)が 500ms 未満で終わる', () => {
  const html = '<ri:user ri:account-id="'.repeat(5000);
  const ms = timeMs(() => htmlToText(html));
  assert.ok(ms < 500, `${ms.toFixed(0)}ms かかった(上限 500ms)`);
});

test('htmlToText: 閉じない <a の繰り返し(約200KB)が 500ms 未満で終わる', () => {
  const html = '<a'.repeat(100000);
  const ms = timeMs(() => htmlToText(html));
  assert.ok(ms < 500, `${ms.toFixed(0)}ms かかった(上限 500ms)`);
});

test('htmlToText(回帰): 入れ子・複数の <ac:link>、行末の空白、閉じない <ac:link> は修正前と同じ結果', () => {
  assert.equal(
    htmlToText('<ac:link><ac:link><ri:page ri:content-title="A"/></ac:link>後<ac:link><ri:page ri:content-title="B"/></ac:link>'),
    '[[A]]後[[B]]',
  );
  assert.equal(htmlToText('a \t \nb  \t\t\nc \t'), 'a\nb\nc');
  assert.equal(htmlToText('x<ac:link>未閉じ<p>y'), 'x 未閉じ\ny');
});

// 閉じない・区切りのない入力で、各正規表現が二乗にならないこと（いずれも約 200KB 以上）
const WORST = {
  '<h1 の繰り返し': '<h1 '.repeat(50000),
  '<li の繰り返し': '<li '.repeat(50000),
  '<td の繰り返し': '<td '.repeat(50000),
  '空白とタブの連続': ' \t'.repeat(100000) + 'x',
  '閉じない <ac:link> の繰り返し(約400KB)': '<ac:link>'.repeat(44000),
  '<ac:link><ri:page の繰り返し(約400KB)': '<ac:link><ri:page '.repeat(22000),
  '属性付きで閉じない <ac:link の繰り返し(約400KB)': '<ac:link '.repeat(44000),
};
for (const [name, html] of Object.entries(WORST)) {
  test(`htmlToText: ${name}が 500ms 未満で終わる`, () => {
    const ms = timeMs(() => htmlToText(html));
    assert.ok(ms < 500, `${ms.toFixed(0)}ms かかった(上限 500ms)`);
  });
}

// script / style / CDATA / structured-macro を含む入力。期待値は、修正前の実装の出力をそのまま固定したもの
const FIXTURE_BLOCKS = [
  '<p>前置き</p>',
  '<SCRIPT type="text/javascript">if (a < b) { x(); }</SCRIPT>',
  '<style>p > a { color: red; }</style>after style',
  '<script>未閉じではない</script><script>二つ目</script>',
  '<style <script>b</script> 壊れた開き',
  '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[let x = [1,2];\nfoo(x[0]);]]></ac:plain-text-body></ac:structured-macro>',
  '<AC:STRUCTURED-MACRO AC:NAME="CODE" ac:schema-version="1"><ac:parameter ac:name="title">t</ac:parameter><ac:plain-text-body>\n <![CDATA[大文字 < 小文字]]>\n </ac:plain-text-body></AC:STRUCTURED-MACRO>',
  '<ac:structured-macro ac:name="noformat"><ac:plain-text-body><![CDATA[noformat本文]]></ac:plain-text-body></ac:structured-macro>',
  '<ac:structured-macro ac:name="code"><ac:rich-text-body><p>本文なし</p></ac:rich-text-body></ac:structured-macro>',
  '<ac:plain-text-body><![CDATA[単独の本文]]></ac:plain-text-body>',
  '<p>生のCDATA <![CDATA[a<b]]> と <![CDATA[二つ目]]> 終わり</p>',
  '<p>閉じない <![CDATA[ 末尾まで</p>',
].join('\n');

const EXPECTED_BLOCKS = "前置き\n\n after style\n\n<style 壊れた開き\n\n```\nlet x = [1,2];\nfoo(x[0]);\n```\n\n```\n大文字 < 小文字\n```\n\nnoformat本文\n\n本文なし\n\n単独の本文\n\n生のCDATA a<b と 二つ目 終わり\n\n閉じない <![CDATA[ 末尾まで";

test('htmlToText(回帰): script / style / CDATA / code マクロを含む HTML の変換結果は修正前と同じ', () => {
  assert.equal(htmlToText(FIXTURE_BLOCKS), EXPECTED_BLOCKS);
});

// 閉じない開きの繰り返しで、script/style・CDATA・structured-macro の各置換が二乗にならないこと（各 400KB 以上）
const WORST_BLOCKS = {
  '<script の繰り返し': '<script'.repeat(60000),
  '<style の繰り返し': '<style'.repeat(70000),
  '<![CDATA[ の繰り返し': '<![CDATA['.repeat(50000),
  '<ac:structured-macro ac:name="code"> の繰り返し': '<ac:structured-macro ac:name="code">'.repeat(24000),
  '属性が閉じない <ac:structured-macro の繰り返し': '<ac:structured-macro '.repeat(20000),
  '<ac:plain-text-body><![CDATA[ の繰り返し': '<ac:plain-text-body><![CDATA['.repeat(40000),
};
for (const [name, html] of Object.entries(WORST_BLOCKS)) {
  test(`htmlToText: ${name}(400KB 以上)が 500ms 未満で終わる`, () => {
    assert.ok(html.length >= 400000, `入力が短い: ${html.length}`);
    const ms = timeMs(() => htmlToText(html));
    assert.ok(ms < 500, `${ms.toFixed(0)}ms かかった(上限 500ms)`);
  });
}
