import test from 'node:test';
import assert from 'node:assert/strict';

import { readEnv } from '../src/util/misc.js';
import { requireEnv } from '../src/connectors/base.js';
import { gitEnv } from '../src/connectors/github.js';
import { createProvider } from '../src/llm/provider.js';

// process.env[name] は toString / constructor / __proto__ などの prototype のキーで
// 関数やオブジェクトを返す。環境変数を名前で引く箇所が「未設定」と扱えることを確かめる。
const PROTO_NAMES = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'];

async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = Object.hasOwn(process.env, k) ? process.env[k] : undefined;
    process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('readEnv: prototype のキー名は undefined', () => {
  for (const n of PROTO_NAMES) assert.equal(readEnv(n), undefined, n);
});

test('readEnv: own の変数は値、空文字は空文字のまま返す', async () => {
  await withEnv({ CG_T_X: 'v', CG_T_EMPTY: '' }, () => {
    assert.equal(readEnv('CG_T_X'), 'v');
    assert.equal(readEnv('CG_T_EMPTY'), '');
  });
  assert.equal(readEnv('CG_T_X'), undefined);
});

test('readEnv: 文字列でない名前は undefined', () => {
  for (const n of [undefined, null, 1, {}, ['toString']]) assert.equal(readEnv(n), undefined);
});

test('requireEnv: prototype のキー名は「未設定」の noRetry エラー', () => {
  for (const n of PROTO_NAMES) {
    assert.throws(() => requireEnv(n, 'hint'), (e) => /未設定/.test(e.message) && e.noRetry === true, n);
  }
});

test('requireEnv: own の変数は値を返す（回帰ガード）', async () => {
  await withEnv({ CG_T_X: 'v' }, () => assert.equal(requireEnv('CG_T_X'), 'v'));
});

test('createProvider: apiKeyEnv が prototype のキー名なら HTTP の前に「未設定」で失敗する', async () => {
  for (const provider of ['anthropic', 'openai-compat']) {
    const p = createProvider({ provider, apiKeyEnv: 'toString', model: 'm', baseUrl: 'http://127.0.0.1:1' });
    await assert.rejects(
      () => p.complete({ user: 'x', schema: { type: 'object' } }),
      (e) => /未設定/.test(e.message) && e.noRetry === true,
      provider,
    );
  }
});

test('gitEnv: tokenEnv が prototype のキー名なら匿名扱い（認証ヘッダを載せない）', () => {
  for (const n of PROTO_NAMES) {
    const env = gitEnv({ auth: { tokenEnv: n } });
    assert.equal(env.GIT_CONFIG_VALUE_0, undefined, n);
    assert.equal(env.GIT_CONFIG_COUNT, undefined, n);
  }
});

test('gitEnv: own の tokenEnv では認証ヘッダを載せる（回帰ガード）', async () => {
  await withEnv({ CG_T_TOKEN: 'tok' }, () => {
    const env = gitEnv({ auth: { tokenEnv: 'CG_T_TOKEN' } });
    assert.match(env.GIT_CONFIG_VALUE_0, /^Authorization: Basic /);
  });
});
