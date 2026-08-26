#!/usr/bin/env node
// 索引の規模と open() のコストを実測する開発者向けスクリプト。
//
//   node scripts/bench-index.mjs <対象ディレクトリ> [include パターン(カンマ区切り)]
//
// IndexStore は open() 時に postings を含めて読み切る（開いた時点のスナップショット）。
// そのコストは索引サイズに比例するため、小規模な索引からの線形外挿は当てにならない
// （205 チャンクからの外挿は 10,541 チャンクの実測を 7.5 倍外した）。判断の前に測ること。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [target, includeArg] = process.argv.slice(2);

if (!target) {
  console.error('使い方: node scripts/bench-index.mjs <対象ディレクトリ> [include パターン(カンマ区切り)]');
  console.error("例:     node scripts/bench-index.mjs ~/repos/some-app 'src/**,docs/**,*.md'");
  process.exit(1);
}

const { loadConfig, paths } = await import(path.join(ROOT, 'src/config.js'));
const { syncSources, buildIndex } = await import(path.join(ROOT, 'src/index/ingest.js'));
const { IndexStore, layout } = await import(path.join(ROOT, 'src/index/store.js'));

const include = (includeArg || 'src/**,*.md').split(',');
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cg-bench-'));
const cfg = path.join(dir, 'bench.config.json');
await fsp.writeFile(cfg, JSON.stringify({
  project: 'bench',
  workspaceDir: path.join(dir, 'ws'),
  sources: [{ id: 'repo', type: 'local', path: path.resolve(target), include }],
  llm: { provider: 'dry', model: 'dry' },
}));

const config = await loadConfig(cfg);
const p = paths(config);
await syncSources(config, {});
await buildIndex(config, { embed: false }); // 埋め込みは測定対象外（API も呼ばない）

const L = layout(p.index);
const size = (f) => fs.statSync(f).size;
const man = JSON.parse(fs.readFileSync(L.manifest, 'utf8'));
const shards = [];
for (let i = 0; i < 32; i++) shards.push(size(L.postings(i)));
const postings = shards.reduce((a, b) => a + b, 0);

const t0 = process.hrtime.bigint();
const store = await IndexStore.open(p.index);
const openMs = Number(process.hrtime.bigint() - t0) / 1e6;

// 検索しないコマンドでも払う分（postings の読み込みだけを切り出して測る）
const m0 = process.memoryUsage().heapUsed;
const t1 = process.hrtime.bigint();
const parsed = [];
for (let i = 0; i < 32; i++) parsed.push(JSON.parse(fs.readFileSync(L.postings(i), 'utf8')));
const postingsMs = Number(process.hrtime.bigint() - t1) / 1e6;
const heapKB = Math.round((process.memoryUsage().heapUsed - m0) / 1024);

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('');
console.log(`チャンク数        ${man.N}`);
console.log(`語彙              ${man.terms}`);
console.log(`postings 合計     ${kb(postings)}  (1 チャンクあたり ${(postings / man.N).toFixed(0)} B)`);
console.log(`docs.txt          ${kb(size(L.docs))}`);
console.log(`docs.meta.json    ${kb(size(L.meta))}`);
console.log(`open()            ${openMs.toFixed(1)} ms`);
const heapText = heapKB > 0 ? kb(heapKB * 1024) : '計測不能(GC)';
console.log(`  うち postings   ${postingsMs.toFixed(1)} ms / ヒープ ${heapText}`);
console.log(`                  ↑ 検索しないコマンドでも払う分`);
console.log('');

await store.close();
await fsp.rm(dir, { recursive: true, force: true });
if (parsed.length !== 32) process.exit(1); // parsed を最適化で消させない
