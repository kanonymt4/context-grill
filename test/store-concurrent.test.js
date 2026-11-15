import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexBuilder, IndexStore, latestGen, layout } from '../src/index/store.js';
import { queryTerms } from '../src/index/tokenize.js';

// 並行する builder が同じ世代を取り合っても、片方の成果物をもう片方が壊さないことを検査する。

const mk = (i, text, p) => ({ id: `s:${p}#0`, docId: `s:${p}`, sourceId: 's', sourceType: 'local', path: p, title: p, kind: 'code', lang: 'js', url: null, version: '1', meta: {}, start: 1, end: 3, hash: String(i), ntok: 10, text });

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-gen-'));
}

async function fill(b, tag) {
  b.add(mk(0, `alpha${tag} function refundPayment() {}`, `${tag}-a.js`));
  b.add(mk(1, `beta${tag} const x = 1;`, `${tag}-b.js`));
}

test('索引(並行): 同じ dir に対して両方 start() しても世代が異なり、両方成功して開ける', async () => {
  const dir = await tmpDir();
  try {
    const a = new IndexBuilder(dir);
    const b = new IndexBuilder(dir);
    await a.start();
    await b.start();
    assert.notEqual(a.L.gen, b.L.gen);
    await fill(a, 'A'); await fill(b, 'B');
    await a.finish({ indexKey: 'a' });
    await b.finish({ indexKey: 'b' });
    const store = await IndexStore.open(dir);
    try {
      assert.equal(store.stats().chunks ?? store.meta.length, 2);
      assert.equal(fs.existsSync(layout(dir, store.L.gen).docs), true);
      const hits = store.bm25(queryTerms('refundPayment'), 3);
      assert.equal(hits.length > 0, true);
      assert.equal(store.textOf(hits[0].idx).includes('refundPayment'), true);
    } finally { await store.close(); }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('索引(並行): A の publish の後・prune の前に B が確保した世代を prune が消さない', async () => {
  const dir = await tmpDir();
  try {
    // 公開済みの世代 1 を用意
    const base = new IndexBuilder(dir);
    await base.start(); await fill(base, 'base'); await base.finish({ indexKey: 'base' });

    const a = new IndexBuilder(dir);
    await a.start();                       // gen 2
    await fill(a, 'A');
    await a.finish({ indexKey: 'a' }, { publish: false });
    const b = new IndexBuilder(dir);
    await b.start();                       // A の publish より前に確保される gen
    await fill(b, 'B');
    assert.notEqual(a.L.gen, b.L.gen);
    assert.ok(b.L.gen > a.L.gen);
    await a.publish();                     // keep = A の世代。B の世代は消えてはならない
    assert.equal(fs.existsSync(b.L.docs), true, 'B の docs が prune で消された');
    await b.finish({ indexKey: 'b' });
    assert.equal(latestGen(dir), b.L.gen);
    const store = await IndexStore.open(dir);
    try {
      assert.equal(store.meta.length, 2);
      assert.equal(store.textOf(0).includes('alphaB'), true);
    } finally { await store.close(); }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('索引(並行): 未公開の高い世代の docs が残っていても、それを避けて確保する', async () => {
  const dir = await tmpDir();
  try {
    await fsp.mkdir(dir, { recursive: true });
    fs.writeFileSync(layout(dir, 1).docs, 'crashed');
    fs.writeFileSync(layout(dir, 2).docs, 'crashed');
    const a = new IndexBuilder(dir);
    await a.start();
    assert.equal(a.L.gen, 3);
    assert.equal(fs.readFileSync(layout(dir, 1).docs, 'utf8'), 'crashed');
    fs.closeSync(a.fd);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('索引(回帰): 単独の publish で旧世代のファイルが消える', async () => {
  const dir = await tmpDir();
  try {
    const g1 = new IndexBuilder(dir);
    await g1.start(); await fill(g1, 'one'); await g1.finish({ indexKey: 'k' });
    const L1 = g1.L;
    const g2 = new IndexBuilder(dir);
    await g2.start(); await fill(g2, 'two'); await g2.finish({ indexKey: 'k' });
    assert.equal(g2.L.gen, L1.gen + 1);
    for (const f of [L1.manifest, L1.meta, L1.df, L1.lens, L1.docs, L1.postings(0)]) {
      assert.equal(fs.existsSync(f), false, `旧世代が残っている: ${f}`);
    }
    const left = fs.readdirSync(L1.postingsDir).filter((n) => n.startsWith(String(L1.gen).padStart(4, '0')));
    assert.deepEqual(left, []);
    for (const f of [g2.L.manifest, g2.L.meta, g2.L.docs]) assert.equal(fs.existsSync(f), true);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('索引(上限): 世代 9999 が公開済みなら、start() は案内つきで失敗し、既存の索引は開けたままにする', async () => {
  // 世代番号は 4 桁固定のファイル名（MANIFEST_RE など）。10000 以降は認識されず、公開すると索引が消える
  const dir = await tmpDir();
  try {
    const first = new IndexBuilder(dir);
    await first.start();
    await fill(first, 'A');
    await first.finish({ indexKey: 'a' });
    // 公開済みの世代を 9999 に付け替える（ファイル名の世代だけを変える）
    const g = first.L.gen;
    for (const f of ['manifest', 'meta', 'df', 'lens', 'docs']) {
      fs.renameSync(layout(dir, g)[f], layout(dir, 9999)[f]);
    }
    for (const n of fs.readdirSync(path.join(dir, 'postings'))) {
      const m = /^(\d{4})\.(\d+)\.json$/.exec(n);
      if (m) fs.renameSync(path.join(dir, 'postings', n), path.join(dir, 'postings', `9999.${m[2]}.json`));
    }
    assert.equal(latestGen(dir), 9999);

    const next = new IndexBuilder(dir);
    await assert.rejects(() => next.start(), /世代番号が上限/);
    // 失敗しても、公開済みの索引は消えず開ける。5 桁のファイルも作られていない
    assert.equal(latestGen(dir), 9999);
    assert.equal(fs.readdirSync(dir).some((n) => /\.\d{5,}\./.test(n)), false);
    const store = await IndexStore.open(dir);
    await store.close();
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
