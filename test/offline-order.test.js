import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { initEgress } from '../src/util/egress.js';
import { syncConfluence } from '../src/connectors/confluence.js';
import { syncJira } from '../src/connectors/jira.js';
import { embedQuery } from '../src/index/embed.js';
import { createProvider } from '../src/llm/provider.js';

// 認証の環境変数が未設定のとき、オフライン（または許可外）の拒否が「未設定」エラーより先に出ること。
// すべて通信前に失敗するので外部通信は起こらない（auditLog:false で egress.log も作らない）。

const OFFLINE_RE = /オフラインモードのため外部通信を拒否しました/;
const UNSET_RE = /未設定/;
const UNSET = {
  email: 'CG_TEST_UNSET_EMAIL_XYZ', token: 'CG_TEST_UNSET_TOKEN_XYZ',
  bearer: 'CG_TEST_UNSET_BEARER_XYZ', key: 'CG_TEST_UNSET_KEY_XYZ',
};
for (const v of Object.values(UNSET)) delete process.env[v];

const BASE = 'https://acme.atlassian.net';
const auth = { emailEnv: UNSET.email, tokenEnv: UNSET.token, bearerEnv: UNSET.bearer };
const confSrc = { id: 'w', type: 'confluence', baseUrl: `${BASE}/wiki`, spaceKey: 'X', auth };
const jiraSrc = { id: 'j', type: 'jira', baseUrl: BASE, projectKey: 'X', auth };
const llmCfg = (provider, baseUrl) => ({ provider, model: 'm', baseUrl, apiKeyEnv: UNSET.key, maxOutputTokens: 10 });
const embCfg = { provider: 'openai-compat', model: 'm', dimensions: 4, baseUrl: 'https://emb.example.test/v1/embeddings', apiKeyEnv: UNSET.key };
const llmInput = { user: 'x' };

function setup(mode) {
  initEgress({
    sources: [confSrc, jiraSrc],
    llm: { provider: 'anthropic' },
    retrieval: { embedding: { provider: 'openai-compat', baseUrl: embCfg.baseUrl } },
    security: { networkMode: mode, auditLog: false },
    workspaceDir: os.tmpdir(),
  });
}

const cases = [
  ['confluence', () => syncConfluence(confSrc, { cache: new Map() })],
  ['jira', () => syncJira(jiraSrc)],
  ['llm anthropic', () => createProvider(llmCfg('anthropic')).complete(llmInput)],
  ['llm openai-compat', () => createProvider(llmCfg('openai-compat', 'https://llm.example.test/v1')).complete(llmInput)],
  ['embedding', () => embedQuery('q', embCfg)],
];

for (const [name, run] of cases) {
  test(`offline: ${name} は認証の環境変数が未設定でもオフラインの文言で拒否される`, async () => {
    setup('offline');
    await assert.rejects(run, (e) => {
      assert.equal(e.name, 'EgressBlocked');
      assert.match(e.message, OFFLINE_RE);
      assert.doesNotMatch(e.message, UNSET_RE);
      return true;
    });
  });
}

// 回帰ガード: normal で許可リスト内のホストなら、従来どおり「未設定」エラー
const normalCases = [
  ['confluence', () => syncConfluence(confSrc, { cache: new Map() })],
  ['jira', () => syncJira(jiraSrc)],
  ['llm anthropic', () => createProvider(llmCfg('anthropic')).complete(llmInput)],
  ['embedding', () => embedQuery('q', embCfg)],
];
for (const [name, run] of normalCases) {
  test(`normal: ${name} は許可済みホストで認証の環境変数が未設定なら「未設定」エラーのまま`, async () => {
    setup('normal');
    await assert.rejects(run, (e) => {
      assert.notEqual(e.name, 'EgressBlocked');
      assert.match(e.message, UNSET_RE);
      return true;
    });
  });
}

test('normal: 許可リストに無いホスト向けの LLM は、未設定ではなく許可外の EgressBlocked が先に出る', async () => {
  setup('normal');
  await assert.rejects(
    () => createProvider(llmCfg('openai-compat', 'https://other.example.test/v1')).complete(llmInput),
    (e) => {
      assert.equal(e.name, 'EgressBlocked');
      assert.match(e.message, /許可されていない宛先/);
      return true;
    });
});
