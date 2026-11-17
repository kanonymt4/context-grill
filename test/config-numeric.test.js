import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { hybridSearch } from '../src/index/search.js';

// 数値の設定が数値でないとき（"high" や "abc"）、黙って NaN になって順位や上限が壊れるのを防ぐ。
// ソース id に Object.prototype のキー名（constructor など）を使えないことも検査する。
// 一時ディレクトリに設定を置くので、リポジトリ直下の .env は読まれない。外部通信は起こさない。
const BASE = { llm: { provider: 'dry', model: 'd' }, sources: [{ id: 'w', type: 'local', path: '.' }] };

async function load(extra) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-numeric-'));
  try {
    const file = path.join(dir, 'context-grill.config.json');
    await fsp.writeFile(file, typeof extra === 'string' ? extra : JSON.stringify({ ...BASE, ...extra }));
    return await loadConfig(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function rejects(extra, ...patterns) {
  await assert.rejects(() => load(extra), (e) => {
    assert.match(e.message, /^設定エラー:\n {2}- /, `実際: ${e.message}`);
    for (const p of patterns) assert.match(e.message, p, `実際: ${e.message}`);
    return true;
  });
}

const src = (extra) => ({ sources: [{ id: 'w', type: 'local', path: '.', ...extra }] });

// [設定の組み立て, エラーに出るパス]
const NUMERIC = [
  [(v) => src({ priority: v }), 'sources\\[0\\]\\.priority'],
  [(v) => ({ retrieval: { boosts: { pathMatch: v } } }), 'retrieval\\.boosts\\.pathMatch'],
  [(v) => ({ retrieval: { boosts: { sourcePriority: v } } }), 'retrieval\\.boosts\\.sourcePriority'],
  [(v) => ({ retrieval: { boosts: { kindPrior: v } } }), 'retrieval\\.boosts\\.kindPrior'],
  [(v) => ({ retrieval: { hybrid: { mmrLambda: v } } }), 'retrieval\\.hybrid\\.mmrLambda'],
  [(v) => ({ retrieval: { hybrid: { final: v } } }), 'retrieval\\.hybrid\\.final'],
  [(v) => ({ retrieval: { hybrid: { perQueryTop: v } } }), 'retrieval\\.hybrid\\.perQueryTop'],
  [(v) => ({ retrieval: { embedding: { dimensions: v } } }), 'retrieval\\.embedding\\.dimensions'],
  [(v) => ({ retrieval: { embedding: { batch: v } } }), 'retrieval\\.embedding\\.batch'],
  [(v) => ({ budget: { evidenceTokens: v } }), 'budget\\.evidenceTokens'],
  [(v) => ({ budget: { staticFactsTokens: v } }), 'budget\\.staticFactsTokens'],
  [(v) => ({ budget: { maxTotalTokensPerRun: v } }), 'budget\\.maxTotalTokensPerRun'],
  [(v) => ({ budget: { maxRepairs: v } }), 'budget\\.maxRepairs'],
  [(v) => ({ llm: { provider: 'dry', model: 'd', maxOutputTokens: v } }), 'llm\\.maxOutputTokens'],
];

test('numeric: 数値のキーに数値でない値（文字列・数値文字列・真偽値・配列・NaN 相当）を書くと設定エラー', async () => {
  for (const [build, at] of NUMERIC) {
    for (const bad of ['high', 'abc', '5', true, [1], { a: 1 }]) {
      await rejects(build(bad), new RegExp(`${at} は有限の数値で指定してください`));
    }
  }
});

test('numeric: JSON に書けない非有限の値は 1e999（Infinity）で表現でき、設定エラーになる', async () => {
  // JSON.parse('1e999') は Infinity になる
  await rejects('{"llm":{"provider":"dry","model":"d"},"sources":[{"id":"w","type":"local","path":".","priority":1e999}]}',
    /sources\[0\]\.priority は有限の数値/);
  await rejects('{"llm":{"provider":"dry","model":"d"},"sources":[{"id":"w","type":"local","path":"."}],"budget":{"maxTotalTokensPerRun":1e999}}',
    /budget\.maxTotalTokensPerRun は有限の数値/);
});

test('numeric: 複数の違反は 1 回で全部列挙される', async () => {
  await rejects({ ...src({ priority: 'high' }), retrieval: { boosts: { pathMatch: 'x' } }, budget: { maxTotalTokensPerRun: 'abc' } },
    /sources\[0\]\.priority/, /retrieval\.boosts\.pathMatch/, /budget\.maxTotalTokensPerRun/);
});

test('numeric: 環境変数の展開で数値が文字列になる形も設定エラー', async () => {
  process.env.CG_T_PRIO = '3';
  try {
    await rejects('{"llm":{"provider":"dry","model":"d"},"sources":[{"id":"w","type":"local","path":".","priority":"${CG_T_PRIO}"}]}',
      /sources\[0\]\.priority は有限の数値/);
  } finally { delete process.env.CG_T_PRIO; }
});

test('numeric: 意味のない範囲（final / perQueryTop / batch が 1 未満の数）は設定エラー', async () => {
  await rejects({ retrieval: { hybrid: { final: 0 } } }, /retrieval\.hybrid\.final は 1 以上/);
  await rejects({ retrieval: { hybrid: { perQueryTop: -3 } } }, /retrieval\.hybrid\.perQueryTop は 1 以上/);
  await rejects({ retrieval: { embedding: { batch: 0 } } }, /retrieval\.embedding\.batch は 1 以上/);
});

test('numeric(回帰ガード): 負の priority・小数・省略・null は通る。既定の設定も通る', async () => {
  for (const p of [-100, -0.5, 0, 1, 2.5]) {
    const c = await load(src({ priority: p }));
    assert.equal(c.sources[0].priority, p);
  }
  const noPrio = await load(src({}));
  assert.equal(noPrio.sources[0].priority, undefined);
  const nul = await load(src({ priority: null }));
  assert.equal(nul.sources[0].priority, null);
  const c = await load({ retrieval: { boosts: { pathMatch: 0, kindPrior: 0.5 }, hybrid: { mmrLambda: 0, final: 5, perQueryTop: 10 } },
    budget: { maxRepairs: 0 }, llm: { provider: 'dry', model: 'd', maxOutputTokens: 100 } });
  assert.equal(c.retrieval.boosts.pathMatch, 0);
  assert.equal(c.budget.maxRepairs, 0);
  await load({});
});

// ---------------------------------------------------------------- 構造
test('numeric: sources の要素や設定の節が object でないときは、生の TypeError でなく設定エラー', async () => {
  await rejects({ sources: [null] }, /sources\[0\] はオブジェクト/);
  await rejects({ sources: ['x'] }, /sources\[0\] はオブジェクト/);
  await rejects({ retrieval: 5 }, /retrieval はオブジェクト/);
  await rejects({ retrieval: { hybrid: 'x' } }, /retrieval\.hybrid はオブジェクト/);
  await rejects({ retrieval: { boosts: [1] } }, /retrieval\.boosts はオブジェクト/);
  await rejects({ budget: 'x' }, /budget はオブジェクト/);
  await rejects({ llm: 3 }, /llm はオブジェクト/);
  await rejects({ security: true }, /security はオブジェクト/);
});

// ---------------------------------------------------------------- ソース id
test('id: Object.prototype のキー名（__proto__ / constructor / prototype / toString など）は設定エラー', async () => {
  for (const id of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf']) {
    await rejects({ sources: [{ id, type: 'local', path: '.' }] }, /sources\[0\]\.id/, /予約/);
  }
});

test('id(回帰ガード): 前方一致するだけの通常の id は通る', async () => {
  for (const id of ['constructors', 'my-constructor', 'proto', 'prototype2', 'to-string']) {
    const c = await load({ sources: [{ id, type: 'local', path: '.' }] });
    assert.equal(c.sources[0].id, id);
  }
});

// ---------------------------------------------------------------- 検索（下の層のゲート）
function fakeStore(sourceId = 's') {
  const meta = [0, 1, 2].map((i) => ({ docId: `d${i}`, path: `f${i}.md`, title: `t${i}`, kind: 'doc', sourceId }));
  return {
    dims: 0,
    meta,
    textOf: (i) => `text ${i}`,
    vecAt: () => null,
    chunkAt(i) { return { ...meta[i], idx: i, text: `text ${i}` }; },
    bm25: () => [{ idx: 0, score: 3 }, { idx: 1, score: 2 }, { idx: 2, score: 1 }],
    vectorSearch: () => [],
  };
}

function searchConfig(boosts = { pathMatch: 0.35, kindPrior: 0.2, sourcePriority: 0.15 }) {
  return {
    security: { allowEmbeddingUpload: false },
    retrieval: {
      embedding: { provider: 'none' },
      glossaryBridge: false,
      hybrid: { final: 3, mmrLambda: 0.72, perQueryTop: 10 },
      boosts,
    },
  };
}

test('search: sourcePriority が NaN なら例外にする（順位を黙って壊さない）', async () => {
  await assert.rejects(
    () => hybridSearch(fakeStore(), { queries: ['q'], config: searchConfig(), sourcePriority: { s: NaN } }),
    /補正|数値/);
  await assert.rejects(
    () => hybridSearch(fakeStore(), { queries: ['q'], config: searchConfig(), sourcePriority: { s: 'high' } }),
    /補正|数値/);
});

test('search: boosts が NaN（文字列）でも例外にする', async () => {
  await assert.rejects(
    () => hybridSearch(fakeStore(), { queries: ['q'], config: searchConfig({ pathMatch: 'x', kindPrior: 0, sourcePriority: 0 }) }),
    /補正|数値/);
});

test('search(回帰ガード): 負の priority・正常な値は従来どおり通り、スコアは有限', async () => {
  for (const p of [-100, 0, 1]) {
    const r = await hybridSearch(fakeStore(), { queries: ['q'], config: searchConfig(), sourcePriority: { s: p } });
    assert.equal(r.length, 3);
    assert.ok(r.every((x) => Number.isFinite(x.score)));
  }
});

test('search: sourceId が constructor でも sourcePriority に無ければ 0 として扱い、NaN にならない', async () => {
  const r = await hybridSearch(fakeStore('constructor'), { queries: ['q'], config: searchConfig(), sourcePriority: {} });
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => Number.isFinite(x.score)), JSON.stringify(r.map((x) => x.score)));
});

// ---------------------------------------------------------------- ソース単位の数値・overlap
// [ソースの組み立て, エラーに出るパス, 最小値]
const SRC_NUMERIC = [
  [(v) => ({ id: 'w', type: 'local', path: '.', maxFileBytes: v }), 'sources\\[0\\]\\.maxFileBytes', 1],
  [(v) => ({ id: 'w', type: 'jira', baseUrl: 'https://example.invalid', limit: v }), 'sources\\[0\\]\\.limit', 0],
  [(v) => ({ id: 'w', type: 'github', repo: 'o/r', maxFiles: v }), 'sources\\[0\\]\\.maxFiles', 0],
  [(v) => ({ id: 'w', type: 'github', repo: 'o/r', depth: v }), 'sources\\[0\\]\\.depth', 1],
  [(v) => ({ id: 'w', type: 'github', repo: 'o/r', maxFileBytes: v }), 'sources\\[0\\]\\.maxFileBytes', 1],
  [(v) => ({ id: 'w', type: 'github', repo: 'o/r', issues: { enabled: true, limit: v } }), 'sources\\[0\\]\\.issues\\.limit', 0],
  [(v) => ({ id: 'w', type: 'github', repo: 'o/r', pulls: { enabled: true, limit: v } }), 'sources\\[0\\]\\.pulls\\.limit', 0],
  [(v) => ({ id: 'w', type: 'confluence', baseUrl: 'https://example.invalid', limit: v }), 'sources\\[0\\]\\.limit', 0],
  [(v) => ({ id: 'w', type: 'confluence', baseUrl: 'https://example.invalid', pageSize: v }), 'sources\\[0\\]\\.pageSize', 0],
  [(v) => ({ id: 'w', type: 'confluence', baseUrl: 'https://example.invalid', maxDepth: v }), 'sources\\[0\\]\\.maxDepth', 0],
  [(v) => ({ id: 'w', type: 'confluence', baseUrl: 'https://example.invalid', updatedWithinDays: v }), 'sources\\[0\\]\\.updatedWithinDays', 0],
];

test('source numeric: ソース単位の数値キーに数値でない値を書くと設定エラー（Jira limit "abc"・local maxFileBytes "big" ほか）', async () => {
  for (const [build, at] of SRC_NUMERIC) {
    for (const bad of ['abc', 'big', '5', true, [1], { a: 1 }]) {
      await rejects({ sources: [build(bad)] }, new RegExp(`${at} は有限の数値で指定してください`));
    }
  }
});

test('source numeric: 範囲外（負の値、maxFileBytes / depth は 0 も）は設定エラー', async () => {
  for (const [build, at, min] of SRC_NUMERIC) {
    await rejects({ sources: [build(min - 1)] }, new RegExp(`${at} は ${min} 以上の数値`));
  }
});

test('source numeric(回帰ガード): 正常な値・省略・null・0（許容されるキー）は通る', async () => {
  for (const [build, , min] of SRC_NUMERIC) {
    await load({ sources: [build(min)] });
    await load({ sources: [build(min + 10)] });
    await load({ sources: [build(null)] });
    await load({ sources: [build(undefined)] });
  }
  await load({ sources: [{ id: 'w', type: 'github', repo: 'o/r', issues: { enabled: true }, pulls: null }] });
});

test('chunk overlap: overlapLines >= maxLines / overlapChars >= maxChars は設定エラー（チャンクが爆発する）', async () => {
  await rejects({ retrieval: { chunk: { code: { overlapLines: 10, maxLines: 10 } } } }, /retrieval\.chunk\.code\.overlapLines は maxLines（10）未満/);
  await rejects({ retrieval: { chunk: { code: { overlapLines: 50, maxLines: 10 } } } }, /retrieval\.chunk\.code\.overlapLines は maxLines/);
  await rejects({ retrieval: { chunk: { doc: { overlapChars: 300, maxChars: 300 } } } }, /retrieval\.chunk\.doc\.overlapChars は maxChars（300）未満/);
});

test('chunk overlap(回帰ガード): overlap が max 未満・既定値は通る', async () => {
  await load({ retrieval: { chunk: { code: { overlapLines: 9, maxLines: 10 }, doc: { overlapChars: 299, maxChars: 300 } } } });
  await load({ retrieval: { chunk: { code: { overlapLines: 0 } } } });
  await load({});
});
