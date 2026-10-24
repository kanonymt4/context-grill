// htmlToText の正規表現が、閉じないタグの繰り返しで二乗・三乗にならないことと、
// 通常の HTML の変換結果が変わらないことの確認。
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/util/html.js';

// Confluence ストレージ形式に近い入力。期待値は、修正前の実装の出力をそのまま固定したもの
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

const EXPECTED = '# 仕様書\n\n担当: @abc123 と @def456 が確認。\n\n属性なし: は account-id なし。\n\n参照 リンク 文字 と\n 改行 <tag> A B\n\n[[設計メモ]]\n\n```\nconst a = 1 < 2;\nif (a) { run(); }\n```\n\n注意書き\n\n- 項目1\n\n- 項目2\n\n- 入れ子\n\n- 手順A\n\n- 手順B\n\n |\n | 列1 | 列2\n\n | a | b 太字\n\n | c\n\n## 見出し2\n\n### 見出し3\n\n整形済み\n テキスト\n\n引用\n\n末尾 空白 多い\n\n段落\n\n<!-- comment --> inline 強調\n\nネスト @q"r 終わり\n\n やること\n\n最後の段落&完了';

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
