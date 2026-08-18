import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isIncluded } from '../util/misc.js';
import { isSensitiveDir } from '../util/sensitive.js';
import { classify, isProbablyBinary, makeDoc, isIndexable } from './base.js';

async function* walk(root, rel = '') {
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    if (isSensitiveDir(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;      // シンボリックリンク経由の外部参照を防ぐ
    if (e.isDirectory()) yield* walk(root, r);
    else if (e.isFile()) yield r;
  }
}

/** ローカルディレクトリ（設計書置き場やモノレポの一部）を一次資料として取り込む */
export async function syncLocal(src, ctx = {}) {
  const root = path.resolve(src.path);
  const maxBytes = src.maxFileBytes ?? 400_000;
  const security = ctx.config?.security || {};
  const docs = [];
  let blocked = 0;
  for await (const rel of walk(root)) {
    if (!isIndexable(rel, security)) { blocked++; continue; }
    if (!isIncluded(rel, src.include || [], src.exclude || [])) continue;
    const abs = path.join(root, rel);
    const st = await fsp.stat(abs);
    if (st.size > maxBytes) continue;
    const buf = await fsp.readFile(abs);
    if (isProbablyBinary(buf)) continue;
    const { kind, lang } = classify(rel);
    if (kind === 'other' && !src.includeUnknownTypes) continue;
    docs.push(makeDoc({
      sourceId: src.id, sourceType: 'local', docPath: rel, title: rel, kind, lang,
      text: buf.toString('utf8'), url: pathToFileURL(abs).href, version: String(st.mtimeMs),
      meta: { root, bytes: st.size },
    }));
  }
  return { docs, state: { syncedAt: new Date().toISOString(), count: docs.length, root, blockedSensitive: blocked } };
}
