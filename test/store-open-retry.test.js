import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexBuilder, IndexStore, latestGen, layout, writeVectors } from '../src/index/store.js';

// open の読み込みの途中で別プロセスの sync が新しい世代を公開し、古い世代を prune した場合の挙動。

const mk = (i, text, p) => ({ id: `s:${p}#0`, docId: `s:${p}`, sourceId: 's', sourceType: 'local', path: p, title: p, kind: 'code', lang: 'js', url: null, version: '1', meta: {}, start: 1, end: 3, hash: String(i), ntok: 10, text });

async function build(dir, tag) {
  const b = new IndexBuilder(dir);
  await b.start();
  b.add(mk(0, `alpha${tag} function refundPayment() {}`, `${tag}-a.js`));
  b.add(mk(1, `beta${tag} const x = 1;`, `${tag}-b.js`));
  await b.finish({ indexKey: tag });
  return b.L.gen;
}

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-retry-'));

/**
 * fsp.readFile を差し替え、条件に合う読み込みが最初に起きた時点で hook() を実行してから本来の読み込みを行う。
 * hook の実行は 1 回だけ（wrapper は呼び出し回数を数えるため fn の間は残す）。finally で必ず戻す。呼び出し回数を返す。
 */
async function withReadHook(match, hook, fn) {
  const orig = fsp.readFile;
  let fired = 0;
  let calls = 0;
  fsp.readFile = async function (p, ...rest) {
    if (typeof p === 'string' && match(p)) {
      calls++;
      if (!fired) {
        fired = 1;
        await hook();
      }
    }
    return orig.call(this, p, ...rest);
  };
  try { await fn(() => calls); } finally { fsp.readFile = orig; }
}

for (const loadPostings of [true, false]) {
  test(`open(再試行): 読み込みの途中で新しい世代が公開され旧世代が prune されても、新しい世代で開ける (postings=${loadPostings})`, async () => {
    const dir = await tmpDir();
    try {
      const g1 = await build(dir, 'old');
      let g2;
      await withReadHook((p) => path.basename(p).startsWith('docs.meta.'), async () => { g2 = await build(dir, 'new'); }, async () => {
        const before = IndexStore.openHandles;
        const store = await IndexStore.open(dir, { postings: loadPostings });
        try {
          assert.ok(g2 > g1);
          assert.equal(store.L.gen, g2);
          assert.equal(store.textOf(0).includes('alphanew'), true);
        } finally { await store.close(); }
        assert.equal(IndexStore.openHandles, before);
      });
      assert.equal(latestGen(dir), g2);
    } finally { await fsp.rm(dir, { recursive: true, force: true }); }
  });
}

test('open(再試行): 世代が進んでいないのに postings が欠けていれば、再試行せず「壊れています」で失敗する', async () => {
  const dir = await tmpDir();
  try {
    const g = await build(dir, 'x');
    const pd = path.join(dir, 'postings');
    const f = fs.readdirSync(pd).sort()[0];
    fs.unlinkSync(path.join(pd, f));
    await withReadHook((p) => path.basename(p).startsWith('manifest.'), async () => {}, async (calls) => {
      const before = IndexStore.openHandles;
      await assert.rejects(IndexStore.open(dir), /索引が壊れています/);
      assert.equal(calls(), 1, '世代が進んでいないのに再試行した');
      assert.equal(IndexStore.openHandles, before);
    });
    assert.equal(latestGen(dir), g);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('open(再試行): 索引が無いときは従来どおり「索引がありません」', async () => {
  const dir = await tmpDir();
  try {
    await assert.rejects(IndexStore.open(dir), /索引がありません/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// dims>0 の世代（ベクトル付き）を作る
async function buildVec(dir, tag) {
  const b = new IndexBuilder(dir);
  await b.start();
  b.add(mk(0, `alpha${tag} function refundPayment() {}`, `${tag}-a.js`));
  b.add(mk(1, `beta${tag} const x = 1;`, `${tag}-b.js`));
  await b.finish({ indexKey: tag }, { publish: false });
  await writeVectors(dir, b.L.gen, [[1, 0], [0, 1]], 2);
  await b.publish();
  return b.L.gen;
}

test('open(再試行): 読み込みの途中で旧世代のベクトルが prune されたら、黙って BM25 のみにせず新しい世代で開き直す', async () => {
  const dir = await tmpDir();
  const origExists = fs.existsSync;
  try {
    const g1 = await buildVec(dir, 'old');
    // 新しい世代は公開直前（manifest.tmp）まで作っておき、open が旧世代のベクトルの有無を見る瞬間に公開する
    const b = new IndexBuilder(dir);
    await b.start();
    b.add(mk(0, 'alphanew function refundPayment() {}', 'new-a.js'));
    b.add(mk(1, 'betanew const x = 1;', 'new-b.js'));
    await b.finish({ indexKey: 'new' }, { publish: false });
    await writeVectors(dir, b.L.gen, [[1, 0], [0, 1]], 2);
    const g2 = b.L.gen;
    const oldVec = layout(dir, g1).vectors;
    let fired = false;
    fs.existsSync = function (p) {
      if (!fired && p === oldVec) {
        fired = true;
        fs.renameSync(b.L.manifestTmp, b.L.manifest);   // 別プロセスの publish
        fs.rmSync(oldVec, { force: true });             // 別プロセスの prune
      }
      return origExists.call(this, p);
    };
    const before = IndexStore.openHandles;
    let store;
    try { store = await IndexStore.open(dir); } finally { fs.existsSync = origExists; }
    try {
      assert.ok(fired, '差し替えが発火していない');
      assert.equal(store.L.gen, g2);
      assert.notEqual(store._vfd, null, 'dims>0 なのにベクトルの fd が null（黙って BM25 のみになっている）');
      assert.ok(store.vectorSearch([1, 0], 2).length > 0);
    } finally { await store.close(); }
    assert.equal(IndexStore.openHandles, before);
  } finally { fs.existsSync = origExists; await fsp.rm(dir, { recursive: true, force: true }); }
});

test('open(再試行): 世代が進んでいないのに dims>0 でベクトルのファイルが無ければ、再試行せず「ベクトル索引が見つかりません」で失敗する', async () => {
  const dir = await tmpDir();
  try {
    const g = await buildVec(dir, 'x');
    fs.unlinkSync(layout(dir, g).vectors);
    await withReadHook((p) => path.basename(p).startsWith('manifest.'), async () => {}, async (calls) => {
      const before = IndexStore.openHandles;
      await assert.rejects(IndexStore.open(dir), /ベクトル索引が見つかりません/);
      assert.equal(calls(), 1, '世代が進んでいないのに再試行した');
      assert.equal(IndexStore.openHandles, before);
    });
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('open(再試行): dims==0 の索引はベクトルのファイルが無くても従来どおり開ける', async () => {
  const dir = await tmpDir();
  try {
    await build(dir, 'x');
    const store = await IndexStore.open(dir);
    try { assert.equal(store.dims, 0); assert.equal(store._vfd, null); } finally { await store.close(); }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
