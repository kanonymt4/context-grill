import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { embedQuery } from '../src/index/embed.js';
import { syncConfluence } from '../src/connectors/confluence.js';

// 環境変数を名前で引く残りの箇所（doctor / confluence / embed / .env ローダ）が、
// toString などの prototype のキーを「設定済み」と扱わないことを検証する。
// 設定は一時ディレクトリに置き、リポジトリ直下の .env を読ませない。外部通信は起こさない。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'context-grill.js');

async function withDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-readenv2-'));
  try {
    await fsp.mkdir(path.join(dir, 'docs'));
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(dir, config) {
  const file = path.join(dir, 'context-grill.config.json');
  await fsp.writeFile(file, JSON.stringify(config));
  return file;
}

function doctor(dir, file, env = {}) {
  const e = { ...process.env, ...env };
  for (const k of Object.keys(e)) if (k.startsWith('CG_T_') && env[k] === undefined) delete e[k];
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json', '-c', file], { encoding: 'utf8', cwd: dir, env: e });
  return JSON.parse(r.stdout);
}

const LOCAL = { id: 'w', type: 'local', path: 'docs' };
const CONF = (auth) => ({ id: 'c', type: 'confluence', baseUrl: 'http://127.0.0.1:1/wiki', spaceKey: 'X', auth });

test('doctor: apiKeyEnv に toString を書いても「設定済み」にならず「未設定」になる', async () => {
  await withDir(async (dir) => {
    const file = await writeConfig(dir, {
      project: 'x', sources: [LOCAL], llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'toString' },
    });
    const c = doctor(dir, file).find((x) => x.name === 'env toString');
    assert.ok(c, 'env toString の行が無い');
    assert.equal(c.ok, false);
    assert.equal(c.detail, '未設定');
  });
});

test('doctor: bearerEnv が設定済みの confluence ソースでは email / token の未設定を出さない', async () => {
  await withDir(async (dir) => {
    const file = await writeConfig(dir, {
      project: 'x', sources: [LOCAL, CONF({ bearerEnv: 'CG_T_BEARER', emailEnv: 'CG_T_EMAIL', tokenEnv: 'CG_T_TOKEN' })],
      llm: { provider: 'dry', model: 'd' },
    });
    const c = doctor(dir, file, { CG_T_BEARER: 'b' });
    assert.equal(c.some((x) => x.name === 'env CG_T_EMAIL'), false);
    assert.equal(c.some((x) => x.name === 'env CG_T_TOKEN'), false);
    const b = c.find((x) => x.name === 'env CG_T_BEARER');
    assert.ok(b && b.ok && b.detail === '設定済み');
  });
});

test('doctor: bearerEnv が未設定なら従来どおり email / token の未設定を出し、bearer の行は出さない', async () => {
  await withDir(async (dir) => {
    const file = await writeConfig(dir, {
      project: 'x', sources: [LOCAL, CONF({ bearerEnv: 'CG_T_BEARER', emailEnv: 'CG_T_EMAIL', tokenEnv: 'CG_T_TOKEN' })],
      llm: { provider: 'dry', model: 'd' },
    });
    const c = doctor(dir, file);
    for (const n of ['CG_T_EMAIL', 'CG_T_TOKEN']) {
      const x = c.find((y) => y.name === `env ${n}`);
      assert.ok(x && !x.ok && x.detail === '未設定', n);
    }
    assert.equal(c.some((x) => x.name === 'env CG_T_BEARER'), false);
  });
});

test('doctor: bearerEnv に toString を書いても bearer 設定済みとは扱わず、email / token の未設定を出す', async () => {
  await withDir(async (dir) => {
    const file = await writeConfig(dir, {
      project: 'x', sources: [LOCAL, CONF({ bearerEnv: 'toString', emailEnv: 'CG_T_EMAIL', tokenEnv: 'CG_T_TOKEN' })],
      llm: { provider: 'dry', model: 'd' },
    });
    const c = doctor(dir, file);
    for (const n of ['CG_T_EMAIL', 'CG_T_TOKEN']) {
      const x = c.find((y) => y.name === `env ${n}`);
      assert.ok(x && !x.ok && x.detail === '未設定', n);
    }
    assert.equal(c.some((x) => x.name === 'env toString'), false);
  });
});

test('confluence: bearerEnv に toString を書いても Bearer 扱いにならず、email の未設定で止まる', async () => {
  const src = CONF({ bearerEnv: 'toString', emailEnv: 'CG_T_NOEMAIL', tokenEnv: 'CG_T_NOTOKEN' });
  await assert.rejects(() => syncConfluence(src, {}), /CG_T_NOEMAIL が未設定/);
});

test('embed: apiKeyEnv に toString を書いても HTTP の前に「未設定」で止まる', async () => {
  const cfg = { provider: 'openai-compat', model: 'm', baseUrl: 'http://127.0.0.1:1', apiKeyEnv: 'toString', dimensions: 4 };
  await assert.rejects(() => embedQuery('q', cfg), /toString が未設定/);
});

test('loadDotEnv: .env の toString=... は own の環境変数として取り込まれる', async () => {
  const had = Object.hasOwn(process.env, 'toString');
  try {
    await withDir(async (dir) => {
      const file = await writeConfig(dir, { project: 'x', sources: [LOCAL], llm: { provider: 'dry', model: 'd' } });
      await fsp.writeFile(path.join(dir, '.env'), 'toString=REALVAL\n');
      await loadConfig(file);
      assert.equal(Object.hasOwn(process.env, 'toString'), true);
      assert.equal(process.env.toString, 'REALVAL');
    });
  } finally {
    if (!had) delete process.env.toString;
  }
});
