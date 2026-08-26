#!/usr/bin/env node
// 索引の中身が変わっていないことを確かめるための指紋を出す。
//
//   node scripts/index-fingerprint.mjs > before.txt
//   （索引の書き込み経路に手を入れる）
//   node scripts/index-fingerprint.mjs > after.txt
//   diff before.txt after.txt
//
// 挙動を変えないつもりの整理（パスの集約、内部構造の入れ替えなど）で、生成物が本当に
// 一致しているかを確かめる用途。テストが通っても、書き出す中身が変わっていないことまでは
// 保証されないため。
//
// 実行ごとに揺れる要素があるので、比較が成り立つよう次のようにしている。
//   - ワークスペースは /tmp に作って使い回す。毎回作り直すと docs.meta.json の url /
//     version / meta.root と manifest.indexKey が変わって比較にならない
//   - manifest.builtAt は必ず変わるので、その 1 キーだけ落としてハッシュを取る
// 埋め込みは呼ばない（API を叩かないため）。vectors.bin は対象外。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadConfig, paths } = await import(ROOT + '/src/config.js');
const { syncSources, buildIndex } = await import(ROOT + '/src/index/ingest.js');

const WS = path.join(os.tmpdir(), 'context-grill-fingerprint');
const CFG = path.join(WS, 'c.json');
const SRC = path.join(WS, 'src');

if (!fs.existsSync(CFG)) {
  await fsp.mkdir(SRC, { recursive: true });
  for (let i = 0; i < 120; i++) {
    await fsp.writeFile(
      path.join(SRC, 'f' + i + '.md'),
      '# doc ' + i + '\nrefundPayment retryWithBackoff alpha beta gamma delta epsilon ' + i + '\n',
    );
  }
  await fsp.writeFile(CFG, JSON.stringify({
    project: 'fingerprint',
    workspaceDir: path.join(WS, 'wsdir'),
    sources: [{ id: 'a', type: 'local', path: SRC, include: ['**'] }],
    llm: { provider: 'dry', model: 'dry' },
  }));
}

const cfg = await loadConfig(CFG);
const p = paths(cfg);
if (!fs.existsSync(path.join(p.workspace, 'cache'))) await syncSources(cfg, {});
await buildIndex(cfg, { embed: false });

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

const walk = (dir, base) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) {
      out.push(...walk(full, rel));
    } else if (rel === 'manifest.json') {
      // builtAt だけ実行ごとに変わるので落とす
      const m = JSON.parse(fs.readFileSync(full, 'utf8'));
      delete m.builtAt;
      out.push([rel, hash(JSON.stringify(m, Object.keys(m).sort()))]);
    } else {
      out.push([rel, hash(fs.readFileSync(full))]);
    }
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
};

const files = walk(p.index, '');
for (const [rel, h] of files) console.log(h + '  ' + rel);
console.log('ファイル数: ' + files.length);
