import test from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../src/llm/jsonschema.js';

// minimum / maximum の単体テスト。数値のときだけ検査し、それ以外の挙動は変えない。

const RANGE = { type: 'integer', minimum: 1, maximum: 100 };

test('jsonschema: minimum / maximum は境界を含み、範囲外を日本語で報告する', () => {
  assert.deepEqual(validate(RANGE, 1, '$.k'), []);
  assert.deepEqual(validate(RANGE, 100, '$.k'), []);
  assert.deepEqual(validate(RANGE, 50, '$.k'), []);
  assert.deepEqual(validate(RANGE, 0, '$.k'), ['$.k: 1 以上にしてください']);
  assert.deepEqual(validate(RANGE, -1, '$.k'), ['$.k: 1 以上にしてください']);
  assert.deepEqual(validate(RANGE, 101, '$.k'), ['$.k: 100 以下にしてください']);
});

test('jsonschema: minimum だけ・maximum だけの指定でも効く', () => {
  assert.deepEqual(validate({ type: 'integer', minimum: 1 }, 1_000_000, '$.n'), []);
  assert.deepEqual(validate({ type: 'integer', minimum: 1 }, 0, '$.n'), ['$.n: 1 以上にしてください']);
  assert.deepEqual(validate({ type: 'number', maximum: 5 }, -1e9, '$.n'), []);
  assert.deepEqual(validate({ type: 'number', maximum: 5 }, 6, '$.n'), ['$.n: 5 以下にしてください']);
});

test('jsonschema: type:number では小数も範囲で検査される（0.5 は minimum:1 に反する）', () => {
  assert.deepEqual(validate({ type: 'number', minimum: 1 }, 0.5, '$.n'), ['$.n: 1 以上にしてください']);
  assert.deepEqual(validate({ type: 'number', minimum: 1 }, 1.5, '$.n'), []);
});

test('jsonschema: type:integer と併用すると、小数は型の違反だけが出る（範囲の違反は重ねない）', () => {
  const e = validate(RANGE, 0.5, '$.k');
  assert.equal(e.length, 1, e.join(' / '));
  assert.match(e[0], /型が integer/);
  assert.equal(validate(RANGE, 1.5, '$.k').length, 1);
});

test('jsonschema: 文字列・null・NaN・Infinity は範囲では検査しない（型の検査に任せる）', () => {
  assert.match(validate(RANGE, '0', '$.k')[0], /型が integer/);
  assert.equal(validate(RANGE, '0', '$.k').length, 1);
  assert.equal(validate(RANGE, null, '$.k').length, 1);
  // type を持たないスキーマでは文字列は範囲の対象外
  assert.deepEqual(validate({ minimum: 1, maximum: 5 }, 'abc', '$.s'), []);
  assert.deepEqual(validate({ minimum: 1, maximum: 5 }, NaN, '$.s'), []);
  assert.deepEqual(validate({ minimum: 1, maximum: 5 }, Infinity, '$.s'), []);
});

test('jsonschema: オブジェクトのプロパティ経由でも範囲を検査し、パスが付く', () => {
  const schema = { type: 'object', properties: { k: RANGE }, additionalProperties: false };
  assert.deepEqual(validate(schema, { k: 5 }), []);
  assert.deepEqual(validate(schema, { k: 0 }), ['$.k: 1 以上にしてください']);
  assert.deepEqual(validate(schema, { k: 101 }), ['$.k: 100 以下にしてください']);
});

test('jsonschema: minimum / maximum を持たないスキーマの挙動は変わらない', () => {
  assert.deepEqual(validate({ type: 'integer' }, -5, '$.n'), []);
  assert.deepEqual(validate({ type: 'number' }, 1e300, '$.n'), []);
  assert.deepEqual(validate({ type: 'string', minLength: 2 }, 'a', '$.s'), ['$.s: 2 文字以上が必要です']);
  assert.deepEqual(validate({ type: 'array', minItems: 1 }, [], '$.a'), ['$.a: 要素が 1 個以上必要です']);
  assert.deepEqual(validate({ type: 'string', enum: ['a'] }, 'b', '$.s'), ['$.s: 値 "b" は許可されていません (許可: a)']);
});
