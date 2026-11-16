import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { syncSources, buildIndex } from '../src/index/ingest.js';
import { IndexStore } from '../src/index/store.js';
import { hybridSearch } from '../src/index/search.js';

// 索引を作ったあとに設定の sources を変えたとき、索引の meta をそのまま使って
// 外したソースの資料を返してはいけない。また、設定が索引の作成後に変わっていることを
// プロセスにつき（同じ組で）1 回だけ警告する。

const WARN_RE = /設定が索引の作成後に変わっています/g;

async function captureStderr(fn) {
  const orig = process.stderr.write;
  const chunks = [];
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  try { return { result: await fn(), stderr: chunks.join('') }; } finally { process.stderr.write = orig; }
}

let ctx;
async function setup() {
  if (ctx) return ctx;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cg-stale-'));
  const write = async (rel, body) => {
    const p = path.join(dir, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, body);
  };
  await write('a/src/pay1.py', 'def pay_settlement():\n    # settlement ledger reconcile\n    return settlement_ledger\n');
  await write('a/src/keep.md', '# settlement notes\n\nsettlement ledger is reconciled nightly.\n');
  await write('b/src/best.md', '# settlement best\n\nsettlement ledger best practice for reconcile.\n');
  const base = {
    project: 'stale',
    sources: [
      { id: 'a', type: 'local', path: path.join(dir, 'a') },
      { id: 'b', type: 'local', path: path.join(dir, 'b') },
    ],
    llm: { provider: 'dry', model: 'dry' },
  };
  const cfgPath = path.join(dir, 'context-grill.config.json');
  await fsp.writeFile(cfgPath, JSON.stringify(base));
  const config = await loadConfig(cfgPath);
  const report = await syncSources(config, { summary: false });
  assert.ok(report.every((r) => r.ok), JSON.stringify(report));
  await buildIndex(config, { embed: false });
  const store = await IndexStore.open(path.join(dir, '.context-grill', 'index'));

  // b を外し、a に exclude を足した設定（sync していない）
  const changed = { ...base, sources: [{ id: 'a', type: 'local', path: path.join(dir, 'a'), exclude: ['**/pay1.py'] }] };
  const cfgPath2 = path.join(dir, 'changed.config.json');
  await fsp.writeFile(cfgPath2, JSON.stringify(changed));
  const config2 = await loadConfig(cfgPath2);
  // b だけ外した設定（a は変えない。exclude の限界の確認用ではなく、sources の絞り込みの単独確認）
  const onlyA = { ...base, sources: [{ id: 'a', type: 'local', path: path.join(dir, 'a') }] };
  const cfgPath3 = path.join(dir, 'onlya.config.json');
  await fsp.writeFile(cfgPath3, JSON.stringify(onlyA));
  const config3 = await loadConfig(cfgPath3);
  ctx = { dir, config, config2, config3, store };
  return ctx;
}

test.after(async () => {
  if (!ctx) return;
  await ctx.store.close();
  await fsp.rm(ctx.dir, { recursive: true, force: true });
});

const search = (store, config, extra = {}) => hybridSearch(store, {
  queries: ['settlement ledger reconcile'], config, k: 10, kindPriors: {}, sourcePriority: {}, ...extra,
});
const sourcesOf = (rs) => new Set(rs.map((r) => r.sourceId));

test('前提: 索引を作った設定のままなら、両方のソースが返り、警告は出ない', async () => {
  const { store, config } = await setup();
  assert.equal(store.manifest.indexKey, config.indexKey);
  const { result, stderr } = await captureStderr(() => search(store, config));
  assert.deepEqual([...sourcesOf(result)].sort(), ['a', 'b']);
  assert.equal(stderr.match(WARN_RE), null, stderr);
});

test('設定から外したソース b のチャンクは、索引に残っていても結果に出ない', async () => {
  const { store, config3 } = await setup();
  const { result } = await captureStderr(() => search(store, config3));
  assert.ok(result.length > 0);
  assert.ok(!result.some((r) => r.sourceId === 'b'), JSON.stringify(result.map((r) => r.path)));
  assert.ok(result.some((r) => r.sourceId === 'a'));
});

test('呼び出し元の filter と AND される（filter が a を外せば、a も出ない）', async () => {
  const { store, config3 } = await setup();
  const { result } = await captureStderr(() => search(store, config3, { filter: (m) => m.sourceId === 'b' }));
  assert.equal(result.length, 0);
});

test('設定が索引の作成後に変わっていれば警告し、同じ組での 2 回目以降は警告しない', async () => {
  const { store, config2 } = await setup();
  assert.notEqual(store.manifest.indexKey, config2.indexKey);
  const first = await captureStderr(() => search(store, config2));
  assert.equal((first.stderr.match(WARN_RE) || []).length, 1, first.stderr);
  assert.match(first.stderr, /context-grill sync/);
  const second = await captureStderr(() => search(store, config2));
  assert.equal(second.stderr.match(WARN_RE), null, second.stderr);
});

test('対照: 別の食い違い（別の indexKey の組）では、改めて 1 回警告する', async () => {
  const { store, config3 } = await setup();
  const other = { ...config3, indexKey: 'other-index-key-for-test' };
  const first = await captureStderr(() => search(store, other));
  assert.equal((first.stderr.match(WARN_RE) || []).length, 1, first.stderr);
  const again = await captureStderr(() => search(store, other));
  assert.equal(again.stderr.match(WARN_RE), null, again.stderr);
});

test('exclude だけの変更は、索引にある a/src/pay1.py を外せない（既知の限界。警告で知らせる）', async () => {
  const { store, config2 } = await setup();
  const { result } = await captureStderr(() => search(store, config2));
  assert.ok(result.some((r) => r.path.endsWith('pay1.py')));
  assert.ok(!result.some((r) => r.sourceId === 'b'));
});

test('対照: config が sources / indexKey を持たない手組み config では、従来どおり何も絞らず警告もしない', async () => {
  const { store, config } = await setup();
  const bare = { retrieval: config.retrieval, security: config.security };
  const { result, stderr } = await captureStderr(() => search(store, bare));
  assert.deepEqual([...sourcesOf(result)].sort(), ['a', 'b']);
  assert.equal(stderr.match(WARN_RE), null, stderr);
});
