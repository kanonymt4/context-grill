import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { syncSources, buildIndex } from '../src/index/ingest.js';
import { runTask, resolveTask, resolveEffort, resolveSourceIds } from '../src/llm/pipeline.js';

// runTask が受け取るタスク名・effort・ソース id の検証。
// 不正な値が黙って通る（prototype のキーを引く、normal に化ける、証拠が 0 件になる）ことを防ぐ。

const SOURCES = [
  { id: 'repo', type: 'local', path: 'repo', include: ['**/*'], includeUnknownTypes: true },
  { id: 'docs', type: 'local', path: 'docs', include: ['**/*'], includeUnknownTypes: true },
];
const XDEEP = { queries: 1, final: 5, evidenceTokens: 5000 };

/** 一時ディレクトリに local ソース 2 つと設定を置く。build=false なら索引は作らない。 */
async function makeProject({ build }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-run-options-'));
  await fsp.mkdir(path.join(dir, 'repo'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'repo', 'handler.js'), 'export function handler() { /* retry timeout */ return "repo-retry-timeout"; }\n');
  await fsp.writeFile(path.join(dir, 'docs', 'guide.md'), '# guide\n\nretry timeout の方針: docs-retry-timeout\n');
  const file = path.join(dir, 'context-grill.config.json');
  await fsp.writeFile(file, JSON.stringify({
    project: 'x', sources: SOURCES, llm: { provider: 'dry', model: 'd' },
    effortPresets: {
      low: { queries: 3, final: 14, evidenceTokens: 20000 },
      normal: { queries: 6, final: 28, evidenceTokens: 55000 },
      deep: { queries: 12, final: 56, evidenceTokens: 110000 },
      xdeep: XDEEP,
    },
  }));
  const config = await loadConfig(file);
  if (build) {
    await syncSources(config, {});
    await buildIndex(config, { embed: false });
  }
  return { dir, config };
}

async function withProject(opts, fn) {
  const { dir, config } = await makeProject(opts);
  try {
    await fn(config);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

const ask = (extra = {}) => ({ taskId: 'spec', instruction: 'retry timeout の仕様', dryRun: true, save: false, ...extra });
const prefixes = (res) => new Set(res.pack.items.map((i) => i.label.split('/')[0]));

// ---------------------------------------------------------------- 単体
test('resolveTask: own のタスク名だけを受理し、prototype のキーや非文字列は未知のタスクで throw する', () => {
  assert.equal(typeof resolveTask('spec').instruction, 'string');
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nope', '', undefined, null, 1, {}]) {
    assert.throws(() => resolveTask(bad), /未知のタスク/, `taskId=${String(bad)}`);
  }
});

test('resolveEffort: own の preset だけを受理し、不明な値は黙って normal にせず throw する', async () => {
  await withProject({ build: false }, async (config) => {
    assert.equal(resolveEffort(config, 'low'), config.effortPresets.low);
    assert.equal(resolveEffort(config, 'xdeep'), config.effortPresets.xdeep, '設定で足した preset は使える');
    assert.equal(resolveEffort(config, undefined), config.effortPresets.normal, 'undefined だけが normal の既定');
    for (const bad of ['foo', 'constructor', '__proto__', 'toString', '', true, null, 1, {}]) {
      assert.throws(() => resolveEffort(config, bad), /未知の effort/, `effort=${String(bad)}`);
    }
    // preset の値がオブジェクトでない場合も受理しない
    const broken = { effortPresets: { normal: { queries: 1 }, bad: null, str: 'x' } };
    assert.throws(() => resolveEffort(broken, 'bad'), /未知の effort/);
    assert.throws(() => resolveEffort(broken, 'str'), /未知の effort/);
  });
});

test('resolveSourceIds: null/undefined は全ソース、それ以外は検証して重複を除く', async () => {
  await withProject({ build: false }, async (config) => {
    assert.equal(resolveSourceIds(config, null), null);
    assert.equal(resolveSourceIds(config, undefined), null);
    assert.deepEqual(resolveSourceIds(config, ['repo']), ['repo']);
    assert.deepEqual(resolveSourceIds(config, ['repo', 'repo']), ['repo']);
    assert.deepEqual(resolveSourceIds(config, ['docs', 'repo', 'docs']), ['docs', 'repo']);
    assert.throws(() => resolveSourceIds(config, 'repo'), /配列/);
    assert.throws(() => resolveSourceIds(config, {}), /配列/);
    assert.throws(() => resolveSourceIds(config, []), /ソースが空です/);
    assert.throws(() => resolveSourceIds(config, ['nope']), /未知のソース: nope/);
    assert.throws(() => resolveSourceIds(config, ['repo', 'nope']), /未知のソース: nope/);
    assert.throws(() => resolveSourceIds(config, ['rep']), /未知のソース/, '部分一致は不可');
    for (const bad of [[1], [''], [null], ['constructor'], ['__proto__'], ['toString']]) {
      assert.throws(() => resolveSourceIds(config, bad), /ソース/, `sourceIds=${JSON.stringify(bad)}`);
    }
  });
});

// ---------------------------------------------------------------- 索引を開く前に検証する
test('runTask: 索引が無い設定でも、不正な taskId は「索引がありません」より先に未知のタスクで止まる', async () => {
  await withProject({ build: false }, async (config) => {
    // 前提: 正しい入力なら索引が無いことで落ちる（検証が索引より先であることの対照）
    await assert.rejects(() => runTask(config, ask()), /索引がありません/);
    for (const taskId of ['constructor', 'toString', '__proto__']) {
      await assert.rejects(() => runTask(config, ask({ taskId })), (e) => /未知のタスク/.test(e.message) && !/索引がありません/.test(e.message), `taskId=${taskId}`);
    }
  });
});

test('runTask: 索引が無い設定でも、不正な effort は未知の effort で止まる', async () => {
  await withProject({ build: false }, async (config) => {
    for (const effort of ['foo', 'constructor', '__proto__', true, null]) {
      await assert.rejects(() => runTask(config, ask({ effort })), (e) => /未知の effort/.test(e.message) && !/索引がありません/.test(e.message), `effort=${String(effort)}`);
    }
  });
});

test('runTask: 索引が無い設定でも、不正な sourceIds はソースのエラーで止まる', async () => {
  await withProject({ build: false }, async (config) => {
    const cases = [
      [['nope'], /未知のソース/],
      [[], /ソースが空です/],
      ['repo', /配列/],
      [['repo', 'nope'], /未知のソース/],
      [[1], /ソース/],
      [[''], /ソース/],
      [['constructor'], /未知のソース/],
    ];
    for (const [sourceIds, re] of cases) {
      await assert.rejects(() => runTask(config, ask({ sourceIds })), (e) => re.test(e.message) && !/索引がありません/.test(e.message), `sourceIds=${JSON.stringify(sourceIds)}`);
    }
  });
});

// ---------------------------------------------------------------- 受理系（索引あり）
test('runTask: sourceIds で証拠のソースが絞られ、重複・省略も通る', async () => {
  await withProject({ build: true }, async (config) => {
    const all = await runTask(config, ask());
    assert.deepEqual([...prefixes(all)].sort(), ['docs', 'repo'], '前提: 絞り込み無しなら両方入る');
    const nul = await runTask(config, ask({ sourceIds: null }));
    assert.deepEqual([...prefixes(nul)].sort(), ['docs', 'repo']);

    const repo = await runTask(config, ask({ sourceIds: ['repo'] }));
    assert.ok(repo.pack.items.length > 0);
    assert.deepEqual([...prefixes(repo)], ['repo']);

    const both = await runTask(config, ask({ sourceIds: ['repo', 'docs'] }));
    assert.deepEqual([...prefixes(both)].sort(), ['docs', 'repo']);

    const dup = await runTask(config, ask({ sourceIds: ['repo', 'repo'] }));
    assert.deepEqual([...prefixes(dup)], ['repo']);
  });
});

test('runTask: effort は検証を通った名前が meta に記録され、独自 preset も使える', async () => {
  await withProject({ build: true }, async (config) => {
    const def = await runTask(config, ask());
    assert.equal(def.meta.effort, 'normal');
    const x = await runTask(config, ask({ effort: 'xdeep' }));
    assert.equal(x.meta.effort, 'xdeep');
    assert.ok(x.meta.queries.length <= XDEEP.queries, `xdeep の queries 上限 ${XDEEP.queries} を超えた: ${x.meta.queries.length}`);
    const low = await runTask(config, ask({ effort: 'low' }));
    assert.equal(low.meta.effort, 'low');
  });
});
