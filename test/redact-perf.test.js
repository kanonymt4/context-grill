import test from 'node:test';
import assert from 'node:assert/strict';

import { redactText } from '../src/util/redact.js';
import { scanAll } from '../src/analysis/static.js';

// 区切りのない長い 1 行で URL_PASSWORD 規則が二乗時間になる問題の回帰テスト。
// ハング防止のため、入力は 200_000 字より大きくしない。
const LONG = 200_000;

function elapsedMs(fn) {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

test('redact: 区切りのない英数字の長い 1 行が 1000ms 未満で処理される', () => {
  const ms = elapsedMs(() => redactText('a'.repeat(LONG)));
  assert.ok(ms < 1000, `redactText に ${Math.round(ms)}ms かかった`);
});

test('redact: 小文字 hex の長い 1 行が 1000ms 未満で処理される', () => {
  const hex = '0123456789abcdef'.repeat(LONG / 16);
  assert.equal(hex.length, LONG);
  const ms = elapsedMs(() => redactText(hex));
  assert.ok(ms < 1000, `redactText に ${Math.round(ms)}ms かかった`);
});

test('redact: URL 内パスワードは従来どおり墨消しされる', () => {
  for (const url of [
    'postgres://user:secret123@host/db',
    'https://x:abcd@example.com',
    'ftp://u:pass1@h',
  ]) {
    const r = redactText(url);
    assert.equal(r.count, 1, url);
    assert.ok(r.text.includes('«REDACTED:URL_PASSWORD»'), url);
    assert.ok(!/secret123|abcd|pass1/.test(r.text), url);
  }
});

test('redact: スキーム名がちょうど 32 字の URL は墨消しされる（境界）', () => {
  // 先頭以外が数字だと途中から一致できないので、スキーム全体の長さが上限に収まるかを直接見られる
  const scheme = `a${'1'.repeat(31)}`;
  assert.equal(scheme.length, 32);
  const r = redactText(`${scheme}://user:secret123@host/db`);
  assert.equal(r.count, 1);
  assert.ok(r.text.includes('«REDACTED:URL_PASSWORD»'));
  assert.ok(!r.text.includes('secret123'));
});

test('redact: スキーム名が 33 字以上の URL は URL_PASSWORD では墨消しされない（既知の限界）', () => {
  // 先頭の英字から 33 字続くスキーム名は上限を超えるため、この規則では拾わない（仕様上の限界）。
  // 先頭が数字だと途中から一致しないので、英字 1 字 + 数字 32 字で 33 字にする。
  const scheme = `a${'1'.repeat(32)}`;
  const r = redactText(`${scheme}://user:secret123@host/db`);
  assert.equal(r.count, 0);
  assert.ok(r.text.includes('secret123'));
});

test('static: 検出行の隣に長い行があっても context の作成が 2000ms 未満で、各行は 300 字で切られる', () => {
  const long = '0123456789abcdef'.repeat(LONG / 16);
  const text = [long, 'const h = crypto.createHash("md5");', 'ok'].join('\n');
  const doc = { kind: 'code', lang: 'javascript', path: 'src/a.js', sourceId: 's', sourceType: 'local', text };
  let findings;
  const ms = elapsedMs(() => { findings = scanAll([doc]); });
  assert.ok(ms < 2000, `scanAll に ${Math.round(ms)}ms かかった`);
  const f = findings.find((x) => x.ruleId === 'SEC-WEAK-HASH');
  assert.ok(f, 'SEC-WEAK-HASH が検出されること');
  const ctxLines = f.context.split('\n');
  assert.equal(ctxLines.length, 3);
  assert.equal(ctxLines[0].length, 300);
  assert.ok(ctxLines.every((l) => l.length <= 300));
});
