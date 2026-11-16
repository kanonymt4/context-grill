import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';

import { loadConfig } from '../src/config.js';

// retrieval.chunk.* / budget.maxRepairs / policy.minEvidencePerItem の検査と、
// indexKey に入れる／入れないものの境界を固定する。外部通信は起こさない。
const SRC = { id: 'w', type: 'local', path: '.' };
const BASE = { llm: { provider: 'dry', model: 'd' }, sources: [SRC] };

async function load(extra) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-chunk-'));
  try {
    const file = path.join(dir, 'context-grill.config.json');
    await fsp.writeFile(file, JSON.stringify({ ...BASE, ...extra }));
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

const chunk = (sec, key, v) => ({ retrieval: { chunk: { [sec]: { [key]: v } } } });

test('chunk: 数値でない値は設定エラー', async () => {
  for (const [sec, key] of [['code', 'maxLines'], ['code', 'overlapLines'], ['code', 'maxChars'], ['doc', 'maxChars'], ['doc', 'overlapChars']]) {
    for (const bad of ['abc', '5', true, [1], { a: 1 }]) {
      await rejects(chunk(sec, key, bad), new RegExp(`retrieval\\.chunk\\.${sec}\\.${key} は有限の数値で指定してください`));
    }
  }
});

test('chunk: 最小値未満は設定エラー（maxLines / maxChars は 1 以上、overlap は 0 以上）', async () => {
  for (const [sec, key, min] of [['code', 'maxLines', 1], ['code', 'maxChars', 1], ['doc', 'maxChars', 1], ['code', 'overlapLines', 0], ['doc', 'overlapChars', 0]]) {
    await rejects(chunk(sec, key, min - 1), new RegExp(`retrieval\\.chunk\\.${sec}\\.${key} は ${min} 以上`));
  }
  await rejects(chunk('code', 'maxLines', -5), /retrieval\.chunk\.code\.maxLines は 1 以上/);
});

test('chunk: 節がオブジェクトでないと設定エラー', async () => {
  await rejects({ retrieval: { chunk: { code: 'x' } } }, /retrieval\.chunk\.code はオブジェクトで指定してください/);
  await rejects({ retrieval: { chunk: { doc: [1] } } }, /retrieval\.chunk\.doc はオブジェクトで指定してください/);
});

test('chunk: 既定値・正常な値・境界値は通る', async () => {
  const c = await load({});
  assert.equal(c.retrieval.chunk.code.maxLines, 110);
  const ok = await load({ retrieval: { chunk: { code: { maxLines: 1, overlapLines: 0, maxChars: 1 }, doc: { maxChars: 500, overlapChars: 0 } } } });
  assert.equal(ok.retrieval.chunk.code.maxLines, 1);
});

test('budget.maxRepairs は 0 以上、policy.minEvidencePerItem は数値で 0 以上', async () => {
  await rejects({ budget: { maxRepairs: -1 } }, /budget\.maxRepairs は 0 以上/);
  await rejects({ policy: { minEvidencePerItem: 'abc' } }, /policy\.minEvidencePerItem は有限の数値/);
  await rejects({ policy: { minEvidencePerItem: -1 } }, /policy\.minEvidencePerItem は 0 以上/);
  const c = await load({ budget: { maxRepairs: 0 }, policy: { minEvidencePerItem: 0 } });
  assert.equal(c.budget.maxRepairs, 0);
  assert.equal((await load({})).policy.minEvidencePerItem, 1);
});

test('indexKey: sources[] の _ で始まるキーは影響しない（ネストは対象外）', async () => {
  const a = await load({ sources: [{ ...SRC, _comment: 'one' }] });
  const b = await load({ sources: [{ ...SRC, _comment: 'two', _x: 1 }] });
  const none = await load({});
  assert.equal(a.indexKey, b.indexKey);
  assert.equal(a.indexKey, none.indexKey);
  // 通常のキーの変更は反映される
  const p = await load({ sources: [{ ...SRC, priority: 3 }] });
  assert.notEqual(p.indexKey, none.indexKey);
  // ネストした _ キーは除かない
  const n1 = await load({ sources: [{ ...SRC, include: [], meta: { _a: 1 } }] });
  const n2 = await load({ sources: [{ ...SRC, include: [], meta: { _a: 2 } }] });
  assert.notEqual(n1.indexKey, n2.indexKey);
});

test('indexKey: extraDenyPaths が空なら変わらず、足すと変わる', async () => {
  const none = await load({});
  assert.equal((await load({ security: { extraDenyPaths: [] } })).indexKey, none.indexKey);
  const a = await load({ security: { extraDenyPaths: ['secret/**'] } });
  const b = await load({ security: { extraDenyPaths: ['other/**'] } });
  assert.notEqual(a.indexKey, none.indexKey);
  assert.notEqual(a.indexKey, b.indexKey);
  // 文字列 1 つは配列に直されるので同じ
  assert.equal((await load({ security: { extraDenyPaths: 'secret/**' } })).indexKey, a.indexKey);
});

test('indexKey: 既定の設定の値が従来のまま（_ キーも extraDenyPaths も無い設定）', async () => {
  // 従来の式（sources / chunk / embedding のみ）と同じ値であることを固定する
  const { sha256, stableStringify } = await import('../src/util/misc.js');
  const c = await load({});
  const old = sha256(stableStringify({
    sources: c.sources,
    chunk: c.retrieval.chunk,
    embedding: { p: c.retrieval.embedding.provider, m: c.retrieval.embedding.model, d: c.retrieval.embedding.dimensions },
  }));
  assert.equal(c.indexKey, old);
});

test('stale 警告: MCP サーバーの再起動を案内する', () => {
  const src = fs.readFileSync(new URL('../src/index/search.js', import.meta.url), 'utf8');
  assert.match(src, /MCP サーバーが常駐している場合は、sync のあと MCP サーバーを再起動してください/);
});

test('indexKey: denySensitivePaths:false は変わり、true（既定）は変わらない', async () => {
  const none = await load({});
  assert.equal((await load({ security: { denySensitivePaths: true } })).indexKey, none.indexKey);
  assert.notEqual((await load({ security: { denySensitivePaths: false } })).indexKey, none.indexKey);
});
