import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 環境変数 CONTEXT_GRILL_LOG_LEVEL に prototype のキー（constructor など）が入っても、水準が壊れない（debug が出ない）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = pathToFileURL(path.join(ROOT, 'src', 'util', 'log.js')).href;

function runWith(level) {
  const code = `import { log } from ${JSON.stringify(LOG)}; log.debug('DEBUG_VISIBLE'); log.info('INFO_VISIBLE');`;
  const env = { ...process.env };
  delete env.CONTEXT_GRILL_LOG_LEVEL;
  if (level !== undefined) env.CONTEXT_GRILL_LOG_LEVEL = level;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
}

for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'bogus']) {
  test(`CONTEXT_GRILL_LOG_LEVEL=${bad} は無視され、既定の info になる`, () => {
    const r = runWith(bad);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('INFO_VISIBLE'), `info が出ない（水準が壊れた）: ${r.stderr}`);
    assert.ok(!r.stderr.includes('DEBUG_VISIBLE'), `debug が出た（水準が壊れた）: ${r.stderr}`);
  });
}

test('CONTEXT_GRILL_LOG_LEVEL=debug / silent は従来どおり効く（回帰ガード）', () => {
  assert.ok(runWith('debug').stderr.includes('DEBUG_VISIBLE'));
  assert.equal(runWith('silent').stderr, '');
});
