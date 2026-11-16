import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexBuilder, IndexStore, latestGen } from '../src/index/store.js';

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
