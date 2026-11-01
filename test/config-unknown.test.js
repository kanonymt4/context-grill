import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as configMod from '../src/config.js';
import { loadConfig, DEFAULTS } from '../src/config.js';
import * as cliMod from '../src/cli.js';
import { syncSources, buildIndex } from '../src/index/ingest.js';
import { runTask } from '../src/llm/pipeline.js';

// 設定の未知のキー（打ち間違い）の検出、rrfK の削除、doctor の Node 検査、予算超過エラーの案内。
// 一時ディレクトリに設定を置くので、リポジトリ直下の .env は読まれない。外部通信は起こさない。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'context-grill.js');
const BASE = { llm: { provider: 'dry', model: 'd' }, sources: [{ id: 'w', type: 'local', path: '.' }] };

const find = (raw) => configMod.findUnknownKeys(raw);
const byPath = (hits, p) => hits.find((h) => h.path === p);

async function withDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-unknown-'));
  try { return await fn(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

async function writeConfig(dir, obj) {
  const file = path.join(dir, 'context-grill.config.json');
  await fsp.writeFile(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}

function cli(dir, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CONTEXT_GRILL_LOG_LEVEL: 'info' } });
}

// ---------------------------------------------------------------- findUnknownKeys
test('findUnknownKeys: 打ち間違えたキーを検出し、近い既知のキーを候補に返す', () => {
  assert.equal(typeof configMod.findUnknownKeys, 'function', 'findUnknownKeys が export されていない');
  const hits = find({
    ...BASE,
    securty: { networkMode: 'offline' },
    security: { allowLLMUpload: false, denySensitivePath: false },
    sources: [{ id: 'w', type: 'local', path: '.', exlude: ['x'] }],
    effortPreset: {},
  });
  assert.equal(byPath(hits, 'securty')?.suggestion, 'security');
  assert.equal(byPath(hits, 'security.allowLLMUpload')?.suggestion, 'security.allowLlmUpload');
  assert.equal(byPath(hits, 'security.denySensitivePath')?.suggestion, 'security.denySensitivePaths');
  assert.equal(byPath(hits, 'sources[0].exlude')?.suggestion, 'sources[0].exclude');
  assert.equal(byPath(hits, 'effortPreset')?.suggestion, 'effortPresets');
  assert.equal(hits.length, 5, JSON.stringify(hits));
});

test('findUnknownKeys: 近い候補が無いキーは suggestion が null', () => {
  const hits = find({ ...BASE, zzzzzzzz: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'zzzzzzzz');
  assert.equal(hits[0].suggestion, null);
});

test('findUnknownKeys: _ で始まるキー・削除済みの古いキー・effortPresets の任意の名前は検出しない', () => {
  const hits = find({
    ...BASE,
    _comment: 'x', _README: 'y',
    language: 'ja',
    policy: { language: 'ja', requireCitations: true, _note: 1 },
    retrieval: { hybrid: { bm25Top: 1, vectorTop: 2, rrfK: 60, final: 28 }, boosts: { titleMatch: 1, pathMatch: 0.3 } },
    llm: { provider: 'dry', model: 'd', plannerModel: 'x' },
    sources: [{ id: 'w', type: 'github', repo: 'a/b', titleGlobs: ['a'], spaceKeys: ['b'], _comment: 'c', auth: { anything: 1 } }],
    effortPresets: { xdeep: { queries: 1, final: 2, evidenceTokens: 3 } },
    presets: [{ name: 'p', whatever: 1 }],
  });
  assert.deepEqual(hits, []);
});

test('findUnknownKeys: effortPresets の中の未知のキーと、型ごとのソースのキーを検査する', () => {
  const hits = find({
    ...BASE,
    effortPresets: { xdeep: { queries: 1, final: 2, evidenceToken: 3 } },
    sources: [
      { id: 'g', type: 'github', repo: 'a/b', issues: { enabled: true, limt: 3 } },
      { id: 'j', type: 'jira', baseUrl: 'https://x', jql: 'a', pageUrls: [] },
    ],
  });
  assert.equal(byPath(hits, 'effortPresets.xdeep.evidenceToken')?.suggestion, 'effortPresets.xdeep.evidenceTokens');
  assert.equal(byPath(hits, 'sources[0].issues.limt')?.suggestion, 'sources[0].issues.limit');
  // jira の型は pageUrls を読まない
  assert.ok(byPath(hits, 'sources[1].pageUrls'));
  assert.equal(hits.length, 3, JSON.stringify(hits));
});

test('findUnknownKeys: 大文字小文字・- と _ の違いだけのキーを候補にする', () => {
  const hits = find({ ...BASE, security: { 'network-mode': 'offline', ALLOWHOSTS: [] } });
  assert.equal(byPath(hits, 'security.network-mode')?.suggestion, 'security.networkMode');
  assert.equal(byPath(hits, 'security.ALLOWHOSTS')?.suggestion, 'security.allowHosts');
});

test('findUnknownKeys: 同梱の example 設定と init の設定は検出なし', async () => {
  const example = JSON.parse(await fsp.readFile(path.join(ROOT, 'context-grill.config.example.json'), 'utf8'));
  assert.deepEqual(find(example), []);
  await withDir(async (dir) => {
    const r = cli(dir, ['init', '--dir', dir]);
    assert.equal(r.status, 0, r.stderr);
    const generated = JSON.parse(await fsp.readFile(path.join(dir, 'context-grill.config.json'), 'utf8'));
    assert.deepEqual(find(generated), []);
  });
});

test('findUnknownKeys: DEFAULTS の全キーを既知として扱う', () => {
  const { presets: _p, ...rest } = DEFAULTS;
  assert.deepEqual(find({ ...rest, sources: [] }), []);
});

// ---------------------------------------------------------------- loadConfig / doctor
test('loadConfig: 未知のキーでは throw せず、stderr に警告する', async () => {
  await withDir(async (dir) => {
    const file = await writeConfig(dir, { ...BASE, securty: { networkMode: 'offline' } });
    // 同じプロセスで警告を拾うため、子プロセスで loadConfig を呼ぶ
    const code = `import { loadConfig } from ${JSON.stringify(path.join(ROOT, 'src', 'config.js'))};` +
      `const c = await loadConfig(${JSON.stringify(file)}); console.log(c.security.networkMode);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'normal');
    assert.match(r.stderr, /未知の設定キー: securty（security のことですか？）/);
  });
});

test('loadConfig: 未知のキーが無ければ警告しない', async () => {
  await withDir(async (dir) => {
    const file = await writeConfig(dir, BASE);
    const code = `import { loadConfig } from ${JSON.stringify(path.join(ROOT, 'src', 'config.js'))};` +
      `await loadConfig(${JSON.stringify(file)});`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /未知の設定キー/);
  });
});

test('doctor: 未知のキーがあると「設定のキー」が ✗ になり、終了コード 1', async () => {
  await withDir(async (dir) => {
    const file = await writeConfig(dir, { ...BASE, securty: { networkMode: 'offline' } });
    const r = cli(dir, ['doctor', '-c', file]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /✗ 設定のキー\s+securty（security のことですか？）/);
    const j = JSON.parse(cli(dir, ['doctor', '-c', file, '--json']).stdout);
    const chk = j.find((c) => c.name === '設定のキー');
    assert.equal(chk?.ok, false);
  });
});

test('doctor: 未知のキーが無ければ「設定のキー」の行を出さない（従来どおり）', async () => {
  await withDir(async (dir) => {
    const file = await writeConfig(dir, BASE);
    const r = cli(dir, ['doctor', '-c', file]);
    assert.doesNotMatch(r.stdout, /設定のキー/);
    assert.match(r.stdout, /✓ 設定の妥当性/);
  });
});

// ---------------------------------------------------------------- rrfK
test('rrfK は DEFAULTS にも example にも無い', async () => {
  assert.equal(Object.hasOwn(DEFAULTS.retrieval.hybrid, 'rrfK'), false);
  const example = JSON.parse(await fsp.readFile(path.join(ROOT, 'context-grill.config.example.json'), 'utf8'));
  assert.equal(Object.hasOwn(example.retrieval.hybrid, 'rrfK'), false);
  assert.equal(DEFAULTS.retrieval.hybrid.final, 28, 'final は search.js が使うので残す');
});

// ---------------------------------------------------------------- Node 検査
test('nodeVersionOk: >=20.10 を判定する', () => {
  assert.equal(typeof cliMod.nodeVersionOk, 'function', 'nodeVersionOk が export されていない');
  const ok = cliMod.nodeVersionOk;
  assert.equal(ok('20.9.0'), false);
  assert.equal(ok('20.0.0'), false);
  assert.equal(ok('20.10.0'), true);
  assert.equal(ok('20.19.4'), true);
  assert.equal(ok('22.1.0'), true);
  assert.equal(ok('21.0.0'), true);
  assert.equal(ok('18.19.0'), false);
  assert.equal(ok('v20.9.0'), false);
  assert.equal(ok('v20.10.0'), true);
});

// ---------------------------------------------------------------- 予算超過の案内
async function budgetError(effort) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-budget-'));
  try {
    await fsp.mkdir(path.join(dir, 'repo'));
    await fsp.writeFile(path.join(dir, 'repo', 'a.js'), 'export const retry = "timeout retry";\n');
    const file = await writeConfig(dir, {
      project: 'x', llm: { provider: 'anthropic', model: 'm' },
      sources: [{ id: 'repo', type: 'local', path: 'repo', include: ['**/*'] }],
      budget: { maxTotalTokensPerRun: 10 },
    });
    const config = await loadConfig(file);
    await syncSources(config, {});
    await buildIndex(config, { embed: false });
    let err = null;
    try { await runTask(config, { taskId: 'spec', instruction: 'retry timeout', effort, save: false }); } catch (e) { err = e; }
    return err;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('予算超過のエラー: effortPresets.<effort>.evidenceTokens と上限の設定名を案内し、効かない budget.evidenceTokens は案内しない', async () => {
  const err = await budgetError('deep');
  assert.ok(err, '予算超過で throw されなかった');
  assert.match(err.message, /budget\.maxTotalTokensPerRun/);
  assert.match(err.message, /effortPresets\.deep\.evidenceTokens/);
  assert.match(err.message, /--effort low/);
  assert.doesNotMatch(err.message, /budget\.evidenceTokens/);
});

test('予算超過のエラー: --effort low を既に指定しているときは --effort low を案内しない', async () => {
  const err = await budgetError('low');
  assert.ok(err, '予算超過で throw されなかった');
  assert.match(err.message, /effortPresets\.low\.evidenceTokens/);
  assert.doesNotMatch(err.message, /--effort low/);
  assert.doesNotMatch(err.message, /budget\.evidenceTokens/);
});
