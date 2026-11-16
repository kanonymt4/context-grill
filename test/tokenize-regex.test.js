// splitIdentifier / tokenize の正規表現が、大文字だけの長い連続で二乗にならないことと、
// 通常の識別子の分割結果が変わらないことの確認。
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, splitIdentifier } from '../src/index/tokenize.js';

// 修正前の splitIdentifier（差分テスト用に複製。二乗になる正規表現を含む）
function splitIdentifierOld(t) {
  return t
    .replace(/[_$]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function timeMs(fn) {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const LIMIT_MS = 500;

// 200KB 級の入力。大文字だけの連続（ACGT の繰り返し）が修正前の最悪ケース
const WORST = {
  'ACGT の繰り返し': 'ACGT'.repeat(50000),
  '大文字 1 文字の繰り返し': 'A'.repeat(200000),
  '小文字だけ': 'abcd'.repeat(50000),
  '数字だけ': '1234'.repeat(50000),
  'aB の繰り返し': 'aB'.repeat(100000),
  '大文字と数字の交互': 'A1'.repeat(100000),
  'アンダースコア区切りの大文字': 'ABC_'.repeat(50000),
};
for (const [name, input] of Object.entries(WORST)) {
  test(`tokenize: ${name}(200KB)が ${LIMIT_MS}ms 未満で終わる`, () => {
    assert.ok(input.length >= 200000, `入力が短い: ${input.length}`);
    const ms = timeMs(() => tokenize(input));
    assert.ok(ms < LIMIT_MS, `${ms.toFixed(0)}ms かかった(上限 ${LIMIT_MS}ms)`);
  });
  test(`splitIdentifier: ${name}(200KB)が ${LIMIT_MS}ms 未満で終わる`, () => {
    const ms = timeMs(() => splitIdentifier(input));
    assert.ok(ms < LIMIT_MS, `${ms.toFixed(0)}ms かかった(上限 ${LIMIT_MS}ms)`);
  });
}

test('splitIdentifier(回帰): 通常の識別子の分割結果は修正前と同じ', () => {
  const cases = {
    camelCase: ['camel', 'case'],
    PascalCase: ['pascal', 'case'],
    HTTPServer: ['http', 'server'],
    parseXMLData: ['parse', 'xml', 'data'],
    snake_case_name: ['snake', 'case', 'name'],
    $scope_id: ['scope', 'id'],
    getHTTP2Response: ['get', 'http2', 'response'],
    ABC: ['abc'],
    userID: ['user', 'id'],
    IOError: ['io', 'error'],
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.deepEqual(splitIdentifier(input), expected, input);
    assert.deepEqual(splitIdentifierOld(input), expected, `旧実装: ${input}`);
  }
});

test('tokenize(回帰): 日本語混じりの文の出力は修正前の出力と同じ', () => {
  // 期待値は、修正前の実装の出力をそのまま固定したもの
  assert.deepEqual(tokenize('parseXMLData を呼ぶ HTTPServer'), [
    'parsexmldata', 'parse', 'xml', 'data', 'を', 'を呼', '呼', '呼ぶ', 'ぶ', 'httpserver', 'http', 'server',
  ]);
});

// 簡単な乱数（再現性のため固定 seed）
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('splitIdentifier(差分): 乱数入力 6 万件で旧実装と出力が一致する', () => {
  const rng = makeRng(20261117);
  const alphabet = [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, 6),
    ...'abcdef',
    ...'0123',
    '_', '$', ' ', '-', '.',
    'あ', '日', 'ア',
  ];
  let mismatches = 0;
  let firstMismatch = null;
  for (let n = 0; n < 60000; n++) {
    const len = Math.floor(rng() * 20);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
    const a = splitIdentifier(s);
    const b = splitIdentifierOld(s);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      mismatches++;
      if (!firstMismatch) firstMismatch = { s, a, b };
    }
  }
  assert.equal(mismatches, 0, `不一致 ${mismatches} 件。最初の例: ${JSON.stringify(firstMismatch)}`);
});
