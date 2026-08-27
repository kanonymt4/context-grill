import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths, ensureDirs } from '../config.js';
import { syncSource } from '../connectors/index.js';
import { readDocsCache, writeDocsCache, readState } from '../connectors/base.js';
import { chunkDocument } from './chunk.js';
import { IndexBuilder, writeVectors } from './store.js';
import { embedChunks } from './embed.js';
import { log } from '../util/log.js';
import { initEgress, egressSummary } from '../util/egress.js';

/** ソース取得（ネットワーク）。キャッシュは source 単位で独立。 */
export async function syncSources(config, { only = null, force = false } = {}) {
  const p = await ensureDirs(config);
  initEgress(config);
  const report = [];
  for (const src of config.sources) {
    if (only && !only.includes(src.id)) continue;
    const dir = p.sourceCache(src.id);
    const prevState = await readState(dir);
    const previousDocs = force ? [] : await readDocsCache(dir);
    log.step(`sync ${src.id} (${src.type})`);
    try {
      const { docs, state } = await syncSource(src, { paths: p, config, previousDocs, prevState, force });
      await writeDocsCache(dir, docs, { ...state, sourceId: src.id, type: src.type });
      report.push({ id: src.id, type: src.type, documents: docs.length, ok: true, state });
      log.info(`  ${src.id}: ${docs.length} ドキュメント` + (state?.blockedSensitive ? ` (機密扱いで除外 ${state.blockedSensitive} 件)` : ''));
    } catch (e) {
      report.push({ id: src.id, type: src.type, ok: false, error: e.message });
      log.error(`  ${src.id}: 失敗 - ${e.message}`);
    }
  }
  const eg = egressSummary();
  if (eg) log.info(`外部通信: ${eg.requests} 回 / 送信 ${eg.bytesSent} bytes / 宛先 ${Object.keys(eg.byHost).join(', ') || 'なし'}`);
  return report;
}

/** キャッシュ済みドキュメントから索引を再構築（ネットワーク不要・完全に決定的） */
export async function buildIndex(config, { embed = true } = {}) {
  const p = await ensureDirs(config);
  initEgress(config);
  const indexDir = p.index;
  await fsp.mkdir(indexDir, { recursive: true });
  const builder = new IndexBuilder(indexDir);
  await builder.start();

  const chunks = [];
  const perSource = {};
  for (const src of config.sources) {
    const docs = await readDocsCache(p.sourceCache(src.id));
    let n = 0;
    // ドキュメント順を安定させる → 索引の doc idx が毎回同じになる
    docs.sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
    for (const d of docs) {
      for (const c of chunkDocument(d, config.retrieval.chunk)) { chunks.push(c); n++; }
    }
    perSource[src.id] = { documents: docs.length, chunks: n };
  }
  for (const c of chunks) builder.add(c);
  // 公開はベクトルまで書き終えてから。公開済みの manifest に dims を書き足すと、
  // 読み手が中途半端な内容を掴む余地ができる。埋め込みが失敗しても BM25 だけで公開する。
  const manifest = await builder.finish({ indexKey: config.indexKey, perSource, project: config.project }, { publish: false });
  log.info(`索引構築: ${chunks.length} チャンク / ${manifest.terms} 語`);

  const embCfg = config.retrieval.embedding;
  if (embed && embCfg.provider !== 'none' && chunks.length) {
    try {
      const vectors = await embedChunks(chunks, embCfg, p.embed, {
        onProgress: (done, total) => log.debug(`  埋め込み ${done}/${total}`),
        security: config.security,
      });
      if (vectors) {
        await writeVectors(indexDir, builder.L.gen, vectors, embCfg.dimensions);
        manifest.dims = embCfg.dimensions;
        log.info(`ベクトル索引: ${vectors.length} × ${embCfg.dimensions} 次元`);
      }
    } catch (e) {
      if (e.noRetry) { await builder.publish(); throw e; }   // 同意不足・宛先ブロックは黙って握り潰さない
      log.warn(`埋め込みに失敗したため BM25 のみで継続します: ${e.message}`);
    }
  }
  await builder.publish();
  return manifest;
}

export async function allDocs(config, sourceIds = null) {
  const p = paths(config);
  const out = [];
  for (const src of config.sources) {
    if (sourceIds && !sourceIds.includes(src.id)) continue;
    out.push(...await readDocsCache(p.sourceCache(src.id)));
  }
  return out;
}
