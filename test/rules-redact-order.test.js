// 静的解析の snippet / context は「墨消ししてから切る」こと。
// 300 字の境界で秘密値が切れると検出規則に一致せず、断片が素通りしていた。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDocument } from '../src/analysis/rules.js';

const TOKEN = 'ghp' + '_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const doc = (text) => ({ sourceId: 's', sourceType: 'github', path: 'src/a.js', kind: 'code', lang: 'js', url: null, text });

test('rules: 300 字の境界で切れる位置の秘密値も snippet に残らない', () => {
  const line = `const a = "${'x'.repeat(270)}"; // ${TOKEN}`;
  const start = line.indexOf(TOKEN);
  assert.ok(start < 300 && start + TOKEN.length > 300, 'fixture が境界をまたぐ');
  assert.ok(start + 4 < 300, 'ghp_ 自体は境界の内側に残る');
  const f = scanDocument(doc(line)).filter((x) => x.ruleId === 'SEC-SECRET-GH-TOKEN');
  assert.ok(f.length > 0, '検出はされる');
  for (const x of f) {
    assert.ok(!x.snippet.includes('ghp_'), `snippet に断片が残る: ${x.snippet.slice(250)}`);
    assert.ok(!x.context.includes('ghp_'), `context に断片が残る: ${x.context.slice(250)}`);
  }
});

test('rules: 隣接行（context）で境界をまたぐ秘密値も残らない', () => {
  const neighbor = `// ${'y'.repeat(280)} ${TOKEN}`;
  const start = neighbor.indexOf(TOKEN);
  assert.ok(start < 300 && start + TOKEN.length > 300, 'fixture が境界をまたぐ');
  const text = [neighbor, 'const k = "AKIA' + 'ABCDEFGHIJKLMNOP";'].join('\n');
  const f = scanDocument(doc(text)).filter((x) => x.ruleId === 'SEC-SECRET-AWS-AKID');
  assert.equal(f.length, 1);
  assert.ok(f[0].context.includes('yyyy'), '隣接行が context に入っている');
  assert.ok(!f[0].context.includes('ghp_'), `context に断片が残る`);
});

test('rules: 対照 - 短い行・秘密値のない行は変わらない', () => {
  const text = ['// 前の行', 'const k = "AKIA' + 'ABCDEFGHIJKLMNOP"; // 説明', '// 次の行'].join('\n');
  const f = scanDocument(doc(text)).find((x) => x.ruleId === 'SEC-SECRET-AWS-AKID');
  assert.ok(f);
  assert.ok(f.snippet.includes('// 説明'), '秘密値以外はそのまま');
  assert.ok(f.context.includes('// 前の行') && f.context.includes('// 次の行'));
  const long = scanDocument(doc(`const k = "AKIA${'ABCDEFGHIJKLMNOP'}"; // ${'z'.repeat(400)}`))[0];
  assert.ok(long.snippet.length <= 300, '墨消し後に 300 字で切る');
  assert.ok(long.snippet.includes('zzzz'));
});
