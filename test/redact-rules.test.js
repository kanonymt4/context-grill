import test from 'node:test';
import assert from 'node:assert/strict';

import { redactText, redactMessage } from '../src/util/redact.js';

// 墨消し規則の取りこぼし（キーがキーワードだけ・`.` を含むキー・YAML・docker-compose・ヘッダ）、
// PEM の 1 行形式、二乗・三乗の正規表現、BEARER を含む環境変数名の回帰テスト。

const SECRET = 'Hunter2Hunter2';

test('redact: キーがキーワードだけ・`.` を含むキー・YAML・リスト・ヘッダの認証情報が墨消しされる', () => {
  const lines = [
    `PASSWORD=${SECRET}`,
    `API_KEY=${SECRET}`,
    `TOKEN=${SECRET}`,
    `SECRET=${SECRET}`,
    `spring.datasource.password=${SECRET}`,
    `db.password = ${SECRET}`,
    `  password: ${SECRET}`,
    `  api_key: ${SECRET}`,
    `- POSTGRES_PASSWORD=${SECRET}`,
    `- DB_PASSWORD=${SECRET}`,
    `      - MYSQL_ROOT_PASSWORD=${SECRET}`,
    `X-Api-Key: ${SECRET}`,
    `x-api-key = ${SECRET}`,
    `export PASSWORD=${SECRET}`,
  ];
  for (const line of lines) {
    const r = redactText(line);
    assert.ok(!r.text.includes(SECRET), `値が残っている: ${JSON.stringify(line)} -> ${JSON.stringify(r.text)}`);
    assert.ok(r.count >= 1, line);
    assert.ok(r.text.includes('«REDACTED:'), line);
  }
});

test('redact: curl の行中の -H "X-Api-Key: ..." も墨消しされる', () => {
  const line = `curl -H "X-Api-Key: ${SECRET}" https://example.test/v1`;
  const r = redactText(line);
  assert.ok(!r.text.includes(SECRET), r.text);
  assert.ok(r.text.includes('https://example.test/v1'));
});

test('redact: 複数行でも行数は保たれ、秘密の行だけが変わる', () => {
  const src = ['server:', '  port: 8080', `  password: ${SECRET}`, '  name: demo'].join('\n');
  const r = redactText(src);
  const out = r.text.split('\n');
  assert.equal(out.length, 4);
  assert.equal(out[0], 'server:');
  assert.equal(out[1], '  port: 8080');
  assert.ok(!out[2].includes(SECRET));
  assert.equal(out[3], '  name: demo');
});

test('redact: 偽陽性 — プレースホルダ・短い値・キーワードの後に英数字が続くキーは墨消ししない', () => {
  // ${VAR} や <...> は PLACEHOLDER が「全体一致」なので現状は墨消しされる（ここでは固定しない）。
  const keep = [
    'password: xxxxxxxx',
    'password=changeme',
    'DB_PASSWORD=changeme',
    '  api_key: your-key'.replace('your-key', 'changeme'),
    'token_count: 5',
    'max_tokens: 100000',
    `password_hash: ${SECRET}`,
    `password_file: /run/secrets/${SECRET}`,
    `secret_name: ${SECRET}`,
    'password: abc',
    'password:',
  ];
  for (const line of keep) {
    const r = redactText(line);
    assert.equal(r.text, line, `変わってはいけない行が変わった: ${JSON.stringify(line)}`);
    assert.equal(r.count, 0, line);
  }
});

test('redact: PEM が 1 行に同居（\\n はエスケープ文字）しても墨消しされ、次の行は無傷', () => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
  const src = [
    `const key = "-----BEGIN RSA PRIVATE KEY-----\\n${body}\\n-----END RSA PRIVATE KEY-----";`,
    'function ok() {',
    '  return 1;',
    '}',
  ].join('\n');
  const r = redactText(src);
  const out = r.text.split('\n');
  assert.equal(out.length, 4);
  assert.ok(!out[0].includes(body), out[0]);
  assert.ok(out[0].includes('«REDACTED:PRIVATE_KEY»'), out[0]);
  assert.ok(out[0].startsWith('const key = "'), out[0]);
  assert.equal(out[1], 'function ok() {');
  assert.equal(out[2], '  return 1;');
  assert.equal(out[3], '}');
  assert.ok(r.kinds.includes('PRIVATE_KEY'));
  assert.ok(r.count >= 1);
});

test('redact: 1 行形式の PEM が 2 つ並んでも両方墨消しされ、BEGIN だけの行は従来どおり複数行を覆う', () => {
  const one = (b) => `-----BEGIN PRIVATE KEY-----\\n${b}\\n-----END PRIVATE KEY-----`;
  const r1 = redactText(`{"a":"${one('AAAAAAAAAAAAAAAA')}","b":"${one('BBBBBBBBBBBBBBBB')}"}\nnext`);
  assert.ok(!/AAAAAAAA|BBBBBBBB/.test(r1.text), r1.text);
  assert.equal(r1.text.split('\n')[1], 'next');

  const multi = ['-----BEGIN PRIVATE KEY-----', 'AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB', '-----END PRIVATE KEY-----', 'after'].join('\n');
  const r2 = redactText(multi);
  const out = r2.text.split('\n');
  assert.equal(out.length, 5);
  assert.ok(!/AAAAAAAA|BBBBBBBB/.test(r2.text));
  assert.equal(out[4], 'after');
});

test('redact: END の無い BEGIN が 1 行に複数あっても二乗にならない', () => {
  const src = '-----BEGIN CERTIFICATE-----'.repeat(7000);
  const t0 = performance.now();
  redactText(src);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `redactText に ${Math.round(ms)}ms かかった`);
});

// ---- 二乗・三乗の正規表現（200,000 字の最悪入力。ハング防止のためこれより大きくしない） ----
const LONG = 200_000;
function timeMs(input) {
  const t0 = performance.now();
  redactText(input);
  return performance.now() - t0;
}

test('redact: authorization: + 空白の長い繰り返しが 1000ms 未満', () => {
  const ms = timeMs(`authorization:${' '.repeat(LONG)}x`);
  assert.ok(ms < 1000, `${Math.round(ms)}ms`);
});

test('redact: \\r の長い繰り返し（m フラグで全部が行頭になる）が 1000ms 未満', () => {
  const ms = timeMs('\r'.repeat(LONG));
  assert.ok(ms < 1000, `${Math.round(ms)}ms`);
});

test('redact: -eyJ の長い繰り返しが 1000ms 未満', () => {
  const ms = timeMs('-eyJ'.repeat(LONG / 4));
  assert.ok(ms < 1000, `${Math.round(ms)}ms`);
});

test('redact: 認証ヘッダ・JWT・CRLF の通常の入力は従来どおり墨消しされる', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  for (const s of [`token ${jwt}`, `"${jwt}"`, `t=${jwt}`, jwt]) {
    const r = redactText(s);
    assert.ok(!r.text.includes(jwt), s);
  }
  for (const s of ['Authorization: Bearer abcdefgh12345678', 'authorization = "Basic dXNlcjpwYXNzd29yZA=="', '"Authorization":"Bearer abcdefgh12345678"']) {
    const r = redactText(s);
    assert.ok(r.text.includes('«REDACTED:AUTH_HEADER»'), s);
  }
});

test('redact: CRLF の .properties でも値が墨消しされ、改行コードと行数は保たれる', () => {
  const src = ['# config', `DB_PASSWORD=${SECRET}`, 'name=demo', `db.password=${SECRET}`, 'end'].join('\r\n') + '\r\n';
  const r = redactText(src);
  assert.ok(!r.text.includes(SECRET), r.text);
  assert.equal(r.text.split('\n').length, src.split('\n').length);
  assert.equal(r.text.split('\r\n').length, src.split('\r\n').length);
  assert.ok(r.text.includes('name=demo\r\n'));
});

// ---- redactMessage ----
test('redactMessage: BEARER を含む名前の環境変数の値が落ちる', () => {
  const value = 'zZ9-bearer-value-0123456789';
  const prev = process.env.ATLASSIAN_BEARER;
  process.env.ATLASSIAN_BEARER = value;
  try {
    const out = redactMessage(`request failed: header was ${value} (status 401)`);
    assert.ok(!out.includes(value), out);
    assert.ok(out.includes('«REDACTED:ATLASSIAN_BEARER»'), out);
  } finally {
    if (prev === undefined) delete process.env.ATLASSIAN_BEARER;
    else process.env.ATLASSIAN_BEARER = prev;
  }
});
