import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';

// 設定の型・値の厳密な検査。誤った指定が黙って効かなくなる（安全側の指定が無効になる）のを防ぐ。
// 一時ディレクトリに設定を置くので、リポジトリ直下の .env は読まれない。外部通信は起こさない。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = { llm: { provider: 'dry', model: 'd' }, sources: [{ id: 'w', type: 'local', path: '.' }] };

async function withDir(fn, { dotenv } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-strict-'));
  try {
    if (dotenv !== undefined) await fsp.writeFile(path.join(dir, '.env'), dotenv);
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// 設定（オブジェクトまたは生の JSON 文字列）を書いて loadConfig する
async function load(extra, opts) {
  return withDir(async (dir) => {
    const file = path.join(dir, 'context-grill.config.json');
    const text = typeof extra === 'string' ? extra : JSON.stringify({ ...BASE, ...extra });
    await fsp.writeFile(file, text);
    return loadConfig(file);
  }, opts);
}

async function rejects(extra, ...patterns) {
  await assert.rejects(() => load(extra), (e) => {
    assert.match(e.message, /^設定エラー:\n {2}- /, `実際: ${e.message}`);
    for (const p of patterns) assert.match(e.message, p, `実際: ${e.message}`);
    return true;
  });
}

async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = Object.hasOwn(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------- (1) 真偽値
const BOOL_KEYS = [
  ['security', 'allowEmbeddingUpload'], ['security', 'allowLlmUpload'], ['security', 'redactSecrets'],
  ['security', 'denySensitivePaths'], ['security', 'auditLog'],
  ['policy', 'requireCitations'], ['policy', 'requireVerbatimQuote'],
  ['policy', 'forbidSpeculativeLanguage'], ['policy', 'dropUnverifiedItems'],
];

test('strict(1): 真偽値のキーに文字列・数値を書くと設定エラーになる（キー名を示す）', async () => {
  for (const [sec, key] of BOOL_KEYS) {
    for (const bad of ['false', 'true', 0, 1]) {
      await rejects({ [sec]: { [key]: bad } }, new RegExp(`${sec}\\.${key} は true / false で指定してください`));
    }
  }
});

test('strict(1): 真偽値のメッセージに文字列 "false" が使えない旨が出る', async () => {
  await rejects({ security: { allowEmbeddingUpload: 'false' } }, /文字列 "false" は使えません/);
});

test('strict(1): 複数の違反は 1 回で全部列挙される', async () => {
  await rejects({ security: { allowEmbeddingUpload: 'false', redactSecrets: 'no' }, policy: { requireCitations: 1 } },
    /security\.allowEmbeddingUpload/, /security\.redactSecrets/, /policy\.requireCitations/);
});

test('strict(1): true / false / null は通る（回帰ガード）', async () => {
  for (const [sec, key] of BOOL_KEYS) {
    for (const ok of [true, false]) {
      const c = await load({ [sec]: { [key]: ok } });
      assert.equal(c[sec][key], ok);
    }
    const c = await load({ [sec]: { [key]: null } });
    assert.equal(typeof c[sec][key], 'boolean'); // null は既定値に戻る
  }
});

test('strict(1): 環境変数の展開で "false" になる形も設定エラー', async () => {
  await withEnv({ CG_T_ALLOW: 'false' }, async () => {
    await rejects(`{"llm":{"provider":"dry","model":"d"},"sources":[{"id":"w","type":"local","path":"."}],"security":{"allowEmbeddingUpload":"\${CG_T_ALLOW}"}}`,
      /security\.allowEmbeddingUpload は true \/ false/);
  });
});

// ---------------------------------------------------------------- (2) sources[].id
test('strict(2): id が不正な形（../ ・ / ・ . ・ .. ・空・日本語・空白）は設定エラー', async () => {
  for (const id of ['../x', '../../../escaped', 'a/b', 'a\\b', '.', '..', '', '私の資料', 'a b']) {
    await rejects({ sources: [{ id, type: 'local', path: '.' }] }, /sources\[0\]\.id/);
  }
});

test('strict(2): 英数字・ . _ - の id は通る', async () => {
  const c = await load({ sources: [{ id: 'my-src_1.v2', type: 'local', path: '.' }] });
  assert.equal(c.sources[0].id, 'my-src_1.v2');
});

// ---------------------------------------------------------------- (3) 配列キー
test('strict(3): allowHosts / extraDenyPaths は文字列 1 つなら配列に直す', async () => {
  const c = await load({ security: { allowHosts: 'example.com', extraDenyPaths: '**/*.js' } });
  assert.deepEqual(c.security.allowHosts, ['example.com']);
  assert.deepEqual(c.security.extraDenyPaths, ['**/*.js']);
});

test('strict(3): allowHosts / extraDenyPaths が配列でも文字列でもない、または要素が文字列でないと設定エラー', async () => {
  for (const key of ['allowHosts', 'extraDenyPaths']) {
    for (const bad of [5, [1], ['ok', 2], { a: 1 }, true]) {
      await rejects({ security: { [key]: bad } }, new RegExp(`security\\.${key}`));
    }
  }
});

test('strict(3): 配列で書いた allowHosts / extraDenyPaths は通る（回帰ガード）', async () => {
  const c = await load({ security: { allowHosts: ['a.example', 'b.example'], extraDenyPaths: ['x/**'] } });
  assert.deepEqual(c.security.allowHosts, ['a.example', 'b.example']);
  assert.deepEqual(c.security.extraDenyPaths, ['x/**']);
});

// ---------------------------------------------------------------- (4) effortPresets
test('strict(4): effortPresets の値の型が違うと設定エラー', async () => {
  await rejects({ effortPresets: { normal: { queries: '6', final: 'x' } } }, /effortPresets\.normal\.queries/, /effortPresets\.normal\.final/);
  await rejects({ effortPresets: { normal: { queries: 0, final: 10 } } }, /effortPresets\.normal\.queries/);
  await rejects({ effortPresets: { normal: { queries: 1.5, final: 10 } } }, /effortPresets\.normal\.queries/);
  await rejects({ effortPresets: { normal: { evidenceTokens: -1 } } }, /effortPresets\.normal\.evidenceTokens/);
  await rejects({ effortPresets: { normal: { evidenceTokens: '9000' } } }, /effortPresets\.normal\.evidenceTokens/);
});

test('strict(4): effortPresets の値がオブジェクトでない、または必須キーが無いと設定エラー', async () => {
  await rejects({ effortPresets: { bad: 5 } }, /effortPresets\.bad はオブジェクト/);
  await rejects({ effortPresets: { bad: [1] } }, /effortPresets\.bad はオブジェクト/);
  await rejects({ effortPresets: { half: { final: 3 } } }, /effortPresets\.half\.queries/);
  await rejects({ effortPresets: { half: { queries: 3 } } }, /effortPresets\.half\.final/);
  await rejects({ effortPresets: 5 }, /effortPresets/);
});

test('strict(4): 独自の段階と、既定の段階の部分指定は通る（回帰ガード）', async () => {
  const c = await load({ effortPresets: { xdeep: { queries: 10, final: 30, evidenceTokens: 9000 }, normal: { final: 10 } } });
  assert.deepEqual(c.effortPresets.xdeep, { queries: 10, final: 30, evidenceTokens: 9000 });
  assert.equal(c.effortPresets.normal.final, 10);
  assert.equal(c.effortPresets.normal.queries, 6); // 既定が残る
});

// ---------------------------------------------------------------- (5) .env の行末コメント
test('strict(5): .env の引用符なしの値は " #" 以降を捨てる。引用符内・空白なしの # は保持する', async () => {
  const names = ['CG_T_K1', 'CG_T_K2', 'CG_T_K3', 'CG_T_K4', 'CG_T_K5', 'CG_T_K6'];
  await withEnv(Object.fromEntries(names.map((n) => [n, undefined])), async () => {
    const dotenv = [
      'CG_T_K1=abc  # c',
      'CG_T_K2="a # b"',
      'CG_T_K3=abc#def',
      "CG_T_K4='x' # c",
      'CG_T_K5=  # c',
      'CG_T_K6=abc\t# tab',
      '',
    ].join('\n');
    await load({}, { dotenv });
    assert.equal(process.env.CG_T_K1, 'abc');
    assert.equal(process.env.CG_T_K2, 'a # b');
    assert.equal(process.env.CG_T_K3, 'abc#def');
    assert.equal(process.env.CG_T_K4, 'x');
    assert.equal(process.env.CG_T_K5, '');
    assert.equal(process.env.CG_T_K6, 'abc');
  });
});

// ---------------------------------------------------------------- 回帰ガード
test('strict: 設定例と init が生成する設定は loadConfig を通る', async () => {
  await withDir(async (dir) => {
    await fsp.copyFile(path.join(ROOT, 'context-grill.config.example.json'), path.join(dir, 'context-grill.config.json'));
    await loadConfig(path.join(dir, 'context-grill.config.json'));
  });
  await withDir(async (dir) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'context-grill.js'), 'init', '--dir', dir],
      { cwd: dir, encoding: 'utf8', env: { ...process.env } });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    await loadConfig(path.join(dir, 'context-grill.config.json'));
  });
});
