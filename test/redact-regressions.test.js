import test from 'node:test';
import assert from 'node:assert/strict';

import { redactText } from '../src/util/redact.js';

// #121（誤検知の削減）が持ち込んだ、本物の秘密を伏せなくなる回帰のテスト。
// 「伏せるべき入力」と「伏せてはいけない入力」（既存の誤検知削減）の両方を固定する。

const V = 'Xk9mQ2pZ7';
const V2 = 'k9mQ2pZ7abc';

function assertRedacted(line, secret) {
  const r = redactText(line);
  assert.ok(!r.text.includes(secret), `値が残っている: ${JSON.stringify(line)} -> ${JSON.stringify(r.text)}`);
  assert.ok(r.count >= 1, line);
}

test('redact(H1): 引用符付き・-- 付き・値が秘密らしい password の続きは伏せる', () => {
  for (const line of [
    `ALTER USER postgres WITH PASSWORD '${V}';`,
    `CREATE USER app WITH PASSWORD '${V}';`,
    `mysql -u root --password ${V} mydb`,
    `enable password ${V}`,
    `AUTH default password ${V}`,
  ]) assertRedacted(line, V);
  // 値が英単語だけの形でも、引用符・-- があれば伏せる（値自体からは秘密と判定できない入力）
  assertRedacted("ALTER USER app WITH PASSWORD 'swordfish';", 'swordfish');
  assertRedacted('mysql -u root --password swordfish mydb', 'swordfish');
});

test('redact(H1): 散文の password は伏せない', () => {
  for (const line of [
    'The password must be at least 8 characters',
    'Enter your password below',
    'Forgot your password reset it here',
    'Use a strong password policy for all accounts',
    'Your password expires in 90 days',
  ]) {
    const r = redactText(line);
    assert.equal(r.text, line);
    assert.equal(r.count, 0, line);
  }
});

test('redact(H2): 値に日本語の注釈が付いても、ASCII の秘密らしい連なりがあれば伏せる', () => {
  assertRedacted(`DB_PASSWORD=${V}（本番）`, V);
  assertRedacted('- API_TOKEN=a8f3c9d2e7b14f6a9c0d（開発環境用）', 'a8f3c9d2e7b14f6a9c0d');
  assertRedacted(`PASSWORD=${V}#本番`, V);
});

test('redact(H2): 日本語の説明文は伏せない', () => {
  for (const line of [
    '- API_KEY: 外部決済APIの認証キー',
    'PASSWORD=本番環境のパスワードを設定する',
    'TOKEN=発行済みトークン（管理画面で確認）',
  ]) {
    const r = redactText(line);
    assert.equal(r.text, line);
    assert.equal(r.count, 0, line);
  }
});

test('redact(M1): `<` `%` で始まるだけの値、your- で始まる値は伏せる', () => {
  assertRedacted(`PASSWORD=<${V2}`, V2);
  assertRedacted(`PASSWORD=%2F${V2}`, V2);
  assertRedacted('PASSWORD=your-real-pass-Xk9', 'your-real-pass-Xk9');
});

test('redact(M1): プレースホルダ・参照の形は伏せない', () => {
  for (const line of [
    'API_KEY=<your-key>',
    'API_KEY=<API_KEY_VALUE>',
    'PASSWORD=%DB_PASSWORD%',
    'API_KEY=your-api-key-here',
    'API_KEY=YOUR_API_KEY',
    'SECRET=$(cat /run/secrets/app)',
    'DB_PASSWORD=${DB_PASSWORD}',
  ]) {
    const r = redactText(line);
    assert.equal(r.text, line);
    assert.equal(r.count, 0, line);
  }
});

test('redact: 追加した判定が長い入力で二乗時間にならない', () => {
  const N = 200_000;
  const cases = [
    'password '.repeat(N / 9),
    'PASSWORD=<' + 'a'.repeat(N),
    'PASSWORD=%' + 'a'.repeat(N),
    'PASSWORD=your-' + 'a'.repeat(N),
    'PASSWORD=' + 'あ'.repeat(N),
    'PASSWORD=' + 'a1あ'.repeat(N / 3),
    "password '" + 'a'.repeat(N),
    '--password '.repeat(N / 11),
  ];
  for (const s of cases) {
    const t0 = performance.now();
    redactText(s);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${s.slice(0, 20)}: ${Math.round(ms)}ms`);
  }
});
