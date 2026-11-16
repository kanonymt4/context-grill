import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexBuilder, IndexStore } from '../src/index/store.js';
import { hybridSearch } from '../src/index/search.js';

// クエリに Object.prototype のキー（constructor など）が含まれ、索引にその語が無いとき、
// df / postings を素のオブジェクトから引いて関数が返り、スコアが NaN になっていた。

const mk = (p, sourceId, text) => ({
  id: `${sourceId}:${p}#0`, docId: `${sourceId}:${p}`, sourceId, sourceType: 'local', path: p, title: p,
  kind: 'doc', lang: 'md', url: null, version: '1', meta: {}, start: 1, end: 3, hash: p, ntok: 10, text,
});

async function withStore(docs, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-protokey-'));
  try {
    const b = new IndexBuilder(dir);
    await b.start();
    for (const d of docs) b.add(d);
    await b.finish({ indexKey: 'k' });
    const store = await IndexStore.open(dir);
    try { await fn(store); } finally { await store.close(); }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

const config = {
  retrieval: {
    embedding: { provider: 'none' }, glossaryBridge: false,
    hybrid: { final: 5, mmrLambda: 0.72, perQueryTop: 10 },
    boosts: { pathMatch: 0, kindPrior: 0, sourcePriority: 0 },
  },
};

const NO_CTOR = [
  mk('a.md', 'proj', 'refund payment flow description'),
  mk('b.md', 'other', 'payment retry policy'),
];

for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
  test(`bm25: 索引に無い prototype のキー (${key}) は 0 件で、例外にも NaN にもならない`, async () => {
    await withStore(NO_CTOR, async (store) => {
      assert.deepEqual(store.bm25(new Map([[key, 1]])), []);
      assert.deepEqual(store.bm25(new Map([[key, 1]]), 100, (m) => m.sourceId === 'proj'), []);
    });
  });
}

test('bm25: 通常の語と constructor を混ぜても、通常の語のヒットだけが残る（スコアは有限）', async () => {
  await withStore(NO_CTOR, async (store) => {
    for (const filter of [null, (m) => m.sourceId === 'proj']) {
      const res = store.bm25(new Map([['payment', 1], ['constructor', 1]]), 100, filter);
      assert.ok(res.length > 0);
      assert.ok(res.every((r) => Number.isFinite(r.score)), JSON.stringify(res));
    }
  });
});

test('postings: 索引に無い prototype のキーは null', async () => {
  await withStore(NO_CTOR, async (store) => {
    assert.equal(store.postings('constructor'), null);
    assert.equal(store.postings('toString'), null);
  });
});

test('hybridSearch: "payment constructor" が落ちず、payment のヒットが残る（filter あり・なし）', async () => {
  await withStore(NO_CTOR, async (store) => {
    const all = await hybridSearch(store, { queries: ['payment constructor'], config, k: 5 });
    assert.deepEqual(all.map((r) => r.path).sort(), ['a.md', 'b.md']);
    const only = await hybridSearch(store, { queries: ['payment constructor'], config, k: 5, filter: (m) => m.sourceId === 'proj' });
    assert.deepEqual(only.map((r) => r.path), ['a.md']);
  });
});

test('対照: constructor を含む文書では従来どおりヒットする', async () => {
  await withStore([...NO_CTOR, mk('c.md', 'proj', 'class with a constructor argument')], async (store) => {
    const res = store.bm25(new Map([['constructor', 1]]));
    assert.deepEqual(res.map((r) => store.meta[r.idx].path), ['c.md']);
    assert.ok(Number.isFinite(res[0].score) && res[0].score > 0);
  });
});

test('bm25: df 側の検査が単独で効く（postings が何か返しても、df に無い prototype のキーは採点しない）', async () => {
  await withStore(NO_CTOR, async (store) => {
    // postings 側の防御を迂回して、df の検査だけを確かめる
    store.postings = () => [0, 1];
    assert.deepEqual(store.bm25(new Map([['constructor', 1]])), []);
  });
});
