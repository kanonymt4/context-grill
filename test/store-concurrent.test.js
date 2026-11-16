import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IndexBuilder, IndexStore, latestGen, layout, writeVectors } from '../src/index/store.js';
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

// 公開済みの世代のファイル名の世代だけを付け替える（世代番号の桁あふれの再現用）
function renumber(dir, from, to) {
  for (const f of ['manifest', 'meta', 'df', 'lens', 'docs']) {
    fs.renameSync(layout(dir, from)[f], layout(dir, to)[f]);
  }
  const pd = path.join(dir, 'postings');
  for (const n of fs.readdirSync(pd)) {
    const m = new RegExp(`^${String(from).padStart(4, '0')}\\.(\\d+)\\.json$`).exec(n);
    if (m) fs.renameSync(path.join(pd, n), path.join(pd, `${String(to).padStart(4, '0')}.${m[1]}.json`));
  }
}

test('索引(桁あふれ): 世代 9999 の次は 5 桁の世代 10000 で公開でき、最新として読め、旧世代は prune される', async () => {
  const dir = await tmpDir();
  try {
    const first = new IndexBuilder(dir);
    await first.start();
    await fill(first, 'A');
    await first.finish({ indexKey: 'a' });
    renumber(dir, first.L.gen, 9999);
    assert.equal(latestGen(dir), 9999);

    const next = new IndexBuilder(dir);
    await next.start();
    assert.equal(next.L.gen, 10000);
    await fill(next, 'B');
    await next.finish({ indexKey: 'b' });
    assert.equal(latestGen(dir), 10000);
    // 数値で比較している（文字列比較なら '9999' > '10000'）。旧世代 9999 は prune で消える
    assert.equal(fs.existsSync(layout(dir, 9999).manifest), false);
    assert.equal(fs.existsSync(layout(dir, 9999).docs), false);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'postings')).filter((n) => n.startsWith('9999.')), []);
    const store = await IndexStore.open(dir);
    try {
      assert.equal(store.L.gen, 10000);
      assert.equal(store.textOf(0).includes('alphaB'), true);
      assert.equal(store.bm25(queryTerms('refundPayment'), 3).length > 0, true);
    } finally { await store.close(); }

    // さらに次の世代 10001 も同様
    const third = new IndexBuilder(dir);
    await third.start();
    assert.equal(third.L.gen, 10001);
    await fill(third, 'C');
    await third.finish({ indexKey: 'c' });
    assert.equal(latestGen(dir), 10001);
    assert.equal(fs.existsSync(layout(dir, 10000).manifest), false);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// 自分より新しい世代が公開された builder は、原因の分かるエラーで失敗し、残骸を残さない
const gen2Leftovers = (dir) => [
  ...fs.readdirSync(dir),
  ...fs.readdirSync(path.join(dir, 'postings')).map((n) => `postings/${n}`),
].filter((n) => /\.0002\./.test(n) || /(^|\/)0002\./.test(n));

test('索引(置き換え): 世代 3 が先に公開されたら、finish(publish:false) 済みの世代 2 の publish は明示的に失敗し、残骸を残さない', async () => {
  const dir = await tmpDir();
  try {
    const base = new IndexBuilder(dir);
    await base.start(); await fill(base, 'base'); await base.finish({ indexKey: 'base' });
    const a = new IndexBuilder(dir); await a.start();   // gen 2
    const b = new IndexBuilder(dir); await b.start();   // gen 3
    assert.equal(a.L.gen, 2); assert.equal(b.L.gen, 3);
    await fill(a, 'A'); await fill(b, 'B');
    await a.finish({ indexKey: 'a' }, { publish: false });
    await b.finish({ indexKey: 'b' });   // 3 を公開 → prune が 2 の作業ファイルを消す
    await assert.rejects(() => writeVectors(dir, 2, [[1, 0], [0, 1]], 2), /世代 2 .*世代 3 .*置き換え/);
    await assert.rejects(() => a.publish(), /世代 2 .*世代 3 .*置き換え/);
    assert.equal(latestGen(dir), 3);
    assert.equal(fs.existsSync(layout(dir, 2).manifest), false);
    assert.deepEqual(gen2Leftovers(dir), []);
    const store = await IndexStore.open(dir);
    try { assert.equal(store.textOf(0).includes('alphaB'), true); } finally { await store.close(); }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('索引(置き換え): 世代 2 が add 中に世代 3 が公開されたら、2 の finish は明示的に失敗し、manifest.0002 を残さない', async () => {
  const dir = await tmpDir();
  try {
    const base = new IndexBuilder(dir);
    await base.start(); await fill(base, 'base'); await base.finish({ indexKey: 'base' });
    const a = new IndexBuilder(dir); await a.start();   // gen 2
    const b = new IndexBuilder(dir); await b.start();   // gen 3
    await fill(a, 'A'); await fill(b, 'B');
    await b.finish({ indexKey: 'b' });
    await assert.rejects(() => a.finish({ indexKey: 'a' }), /世代 2 .*世代 3 .*置き換え/);
    assert.equal(latestGen(dir), 3);
    assert.deepEqual(gen2Leftovers(dir), []);
    const store = await IndexStore.open(dir);
    try { assert.equal(store.textOf(0).includes('alphaB'), true); } finally { await store.close(); }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// publish() の確認から rename までの隙間で別の builder が公開した場合の再確認。
// fsp.rename を 1 回だけ差し替える（store.js と同じ default export の fsp オブジェクト）。
async function withRenameHook(target, { before, after, fail }, fn) {
  const real = fsp.rename;
  let armed = true;
  fsp.rename = async (src, dst) => {
    if (armed && src === target) {
      armed = false;                       // B 自身の rename で再帰しない
      try {
        if (before) await before();
        if (fail) throw fail;
        const r = await real.call(fsp, src, dst);
        if (after) await after();
        return r;
      } finally { fsp.rename = real; }
    }
    return real.call(fsp, src, dst);
  };
  try { await fn(); } finally { fsp.rename = real; }
}

async function prepare() {
  const dir = await tmpDir();
  const base = new IndexBuilder(dir);
  await base.start(); await fill(base, 'base'); await base.finish({ indexKey: 'base' });
  const a = new IndexBuilder(dir); await a.start();   // gen 2
  const b = new IndexBuilder(dir); await b.start();   // gen 3
  await fill(a, 'A'); await fill(b, 'B');
  return { dir, a, b };
}

test('索引(置き換え): rename の直前に新しい世代が公開・prune されて ENOENT になっても、置き換えとして失敗する', async () => {
  const { dir, a, b } = await prepare();
  try {
    await a.finish({ indexKey: 'a' }, { publish: false });
    await withRenameHook(a.L.manifestTmp, { before: () => b.finish({ indexKey: 'b' }) }, async () => {
      await assert.rejects(() => a.publish(), /置き換え/);
    });
    assert.equal(latestGen(dir), 3);
    assert.deepEqual(gen2Leftovers(dir), []);
    const store = await IndexStore.open(dir);
    try { assert.equal(store.textOf(0).includes('alphaB'), true); } finally { await store.close(); }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('索引(置き換え): rename の直後に新しい世代が公開されたら、成功を返さず自世代を破棄する', async () => {
  const { dir, a, b } = await prepare();
  try {
    await a.finish({ indexKey: 'a' }, { publish: false });
    await b.finish({ indexKey: 'b' }, { publish: false });
    await withRenameHook(a.L.manifestTmp, { after: () => fsp.rename(b.L.manifestTmp, b.L.manifest) }, async () => {
      await assert.rejects(() => a.publish(), /置き換え/);
    });
    assert.equal(latestGen(dir), 3);
    assert.equal(fs.existsSync(layout(dir, 2).manifest), false);
    assert.deepEqual(gen2Leftovers(dir), []);
    const store = await IndexStore.open(dir);
    try { assert.equal(store.textOf(0).includes('alphaB'), true); } finally { await store.close(); }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('索引(置き換え): 新しい世代が無いときの rename 失敗は元の例外のまま投げ、自世代のファイルを消さない', async () => {
  const dir = await tmpDir();
  try {
    const a = new IndexBuilder(dir); await a.start();
    await fill(a, 'A');
    await a.finish({ indexKey: 'a' }, { publish: false });
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    await withRenameHook(a.L.manifestTmp, { fail: eacces }, async () => {
      await assert.rejects(() => a.publish(), (e) => e === eacces && !e.superseded);
    });
    assert.equal(fs.existsSync(a.L.docs), true);
    assert.equal(fs.existsSync(a.L.manifestTmp), true);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
