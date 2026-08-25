import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tokenize } from './tokenize.js';

const SHARDS = 32;
const FORMAT_VERSION = 1;

function shardOf(term) {
  let h = 2166136261;
  for (let i = 0; i < term.length; i++) { h ^= term.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % SHARDS;
}

/**
 * 純 JS の転置索引 + ベクトル索引。ネイティブ依存なし = どの OS/Node にコピーしても動く。
 * 本文は docs.txt に連結して保存し、メタのオフセットで遅延読み出しする（メモリ使用量を一定に保つ）。
 */
export class IndexBuilder {
  constructor(dir) {
    this.dir = dir;
    this.meta = [];
    this.postings = new Map();
    this.lens = [];
    this.off = 0;
    this.fd = null;
  }
  async start() {
    await fsp.mkdir(path.join(this.dir, 'postings'), { recursive: true });
    this.fd = fs.openSync(path.join(this.dir, 'docs.txt.tmp'), 'w');
  }
  add(chunk) {
    const idx = this.meta.length;
    const buf = Buffer.from(chunk.text, 'utf8');
    fs.writeSync(this.fd, buf);
    const toks = tokenize(chunk.text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    // タイトル・パスは重み付けのため 3 回加算
    for (const t of tokenize(`${chunk.title} ${chunk.path}`)) tf.set(t, (tf.get(t) || 0) + 3);
    for (const [t, c] of tf) {
      let a = this.postings.get(t);
      if (!a) { a = []; this.postings.set(t, a); }
      a.push(idx, c);
    }
    this.lens.push(toks.length || 1);
    const { text, ...rest } = chunk;
    this.meta.push({ ...rest, off: this.off, len: buf.length });
    this.off += buf.length;
    return idx;
  }
  async finish(extra = {}) {
    fs.closeSync(this.fd);
    await fsp.rename(path.join(this.dir, 'docs.txt.tmp'), path.join(this.dir, 'docs.txt'));
    const shards = Array.from({ length: SHARDS }, () => ({}));
    const df = {};
    for (const [term, arr] of this.postings) {
      shards[shardOf(term)][term] = arr;
      df[term] = arr.length / 2;
    }
    await Promise.all(shards.map((s, i) => fsp.writeFile(path.join(this.dir, 'postings', `${i}.json`), JSON.stringify(s))));
    await fsp.writeFile(path.join(this.dir, 'df.json'), JSON.stringify(df));
    await fsp.writeFile(path.join(this.dir, 'lens.json'), JSON.stringify(this.lens));
    await fsp.writeFile(path.join(this.dir, 'docs.meta.json'), JSON.stringify(this.meta));
    const N = this.meta.length;
    const manifest = {
      formatVersion: FORMAT_VERSION,
      builtAt: new Date().toISOString(),
      N,
      avgdl: N ? this.lens.reduce((a, b) => a + b, 0) / N : 1,
      terms: this.postings.size,
      dims: 0,
      ...extra,
    };
    await fsp.writeFile(path.join(this.dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    this.postings.clear();
    return manifest;
  }
}

export class IndexStore {
  /**
   * IndexStore が保持している fd の数。**close() 後に 0 に戻ることを不変条件とする。**
   *
   * 例外パスで close() を通らないと 0 に戻らないため、fd リークの回帰テストに使う。
   * POSIX は開いているファイルでも unlink できるため、リークは Windows でしか
   * 症状（rmdir の ENOTEMPTY）として現れない。OS に依らず検知するための計測点。
   */
  static openHandles = 0;

  /**
   * open された累計回数。**減らない。**
   *
   * close() は _fd を null に戻すだけで、次の読み取りが遅延オープンで開き直す。
   * そのため openHandles では「途中で閉じられたか」を検知できない。
   * この累計値が増えていなければ、開き直しが起きていない = 閉じられていない、と言える。
   */
  static openCount = 0;

  static _openFd(p) {
    const fd = fs.openSync(p, 'r');
    IndexStore.openHandles++;
    IndexStore.openCount++;
    return fd;
  }

  static _closeFd(fd) {
    fs.closeSync(fd);
    IndexStore.openHandles--;
  }

  constructor(dir) { this.dir = dir; this._shards = new Map(); this._fd = null; this._vfd = null; }

  static exists(dir) { return fs.existsSync(path.join(dir, 'manifest.json')); }

  static async open(dir, opts = {}) {
    const { postings: loadPostings = true } = opts;
    const s = new IndexStore(dir);
    if (!IndexStore.exists(dir)) throw new Error(`索引がありません (${dir})。先に \`context-grill sync\` を実行してください。`);
    s.manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    s.meta = JSON.parse(await fsp.readFile(path.join(dir, 'docs.meta.json'), 'utf8'));
    s.df = JSON.parse(await fsp.readFile(path.join(dir, 'df.json'), 'utf8'));
    s.lens = JSON.parse(await fsp.readFile(path.join(dir, 'lens.json'), 'utf8'));
    if (loadPostings) {
      // postings も open() 時に読み切る。docs.txt は fd 保持で古い実体を読み続けるのに対し、
      // 遅延読み込みの postings はパス指定で新しい実体を読む。この非対称のため、索引を
      // 作り直すと meta と doc id の世代がずれ、store.meta[idx] が undefined になる。
      s._shards = new Map(await Promise.all(Array.from({ length: SHARDS }, async (_, i) => {
        const f = path.join(dir, 'postings', `${i}.json`);
        try {
          return [i, JSON.parse(await fsp.readFile(f, 'utf8'))];
        } catch (e) {
          // 欠損や破損を黙って空シャードとして扱うと、その語だけ静かに 0 ヒットになる。
          throw new Error(`索引が壊れています (${dir})。postings/${i}.json を読めません: ${e.message}\n\`context-grill sync\` で作り直してください。`);
        }
      })));
    } else {
      // postings 未ロード。検索しないコマンド（status 等）向け。触ると postings() で明確なエラーになる。
      s._shards = null;
    }
    s.N = s.manifest.N;
    s.avgdl = s.manifest.avgdl || 1;
    s.dims = s.manifest.dims || 0;
    return s;
  }

  async close() {
    if (this._fd !== null) { IndexStore._closeFd(this._fd); this._fd = null; }
    if (this._vfd !== null) { IndexStore._closeFd(this._vfd); this._vfd = null; }
  }

  _shard(i) { return this._shards.get(i); }
  postings(term) {
    if (this._shards === null) throw new Error('postings が未ロードです（IndexStore.open(dir, { postings: false }) で開いたストアは検索できません。IndexStore.open(dir) で開き直してください）。');
    return this._shard(shardOf(term))[term] || null;
  }

  textOf(i) {
    const m = this.meta[i];
    if (!m) return '';
    if (this._fd === null) this._fd = IndexStore._openFd(path.join(this.dir, 'docs.txt'));
    const buf = Buffer.allocUnsafe(m.len);
    fs.readSync(this._fd, buf, 0, m.len, m.off);
    return buf.toString('utf8');
  }

  chunkAt(i) { return { ...this.meta[i], idx: i, text: this.textOf(i) }; }

  /** Okapi BM25 */
  bm25(termMap, topK = 100, filter = null) {
    const k1 = 1.2, b = 0.75;
    const scores = new Map();
    for (const [term, qtf] of termMap) {
      const df = this.df[term];
      if (!df) continue;
      if (df / this.N > 0.6 && term.length <= 2) continue; // 高頻度な CJK 1-gram はノイズ
      const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
      const post = this.postings(term);
      if (!post) continue;
      const qw = 1 + Math.log(qtf);
      for (let i = 0; i < post.length; i += 2) {
        const d = post[i], tf = post[i + 1];
        if (filter && !filter(this.meta[d])) continue;
        const dl = this.lens[d] || 1;
        const s = qw * idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / this.avgdl));
        scores.set(d, (scores.get(d) || 0) + s);
      }
    }
    return topN(scores, topK);
  }

  vecAt(i) {
    if (!this.dims) return null;
    if (this._vfd === null) {
      const p = path.join(this.dir, 'vectors.bin');
      if (!fs.existsSync(p)) return null;
      this._vfd = IndexStore._openFd(p);
    }
    const bytes = this.dims * 4;
    const buf = Buffer.allocUnsafe(bytes);
    fs.readSync(this._vfd, buf, 0, bytes, i * bytes);
    return new Float32Array(buf.buffer, buf.byteOffset, this.dims);
  }

  /** 正規化済みベクトル前提のコサイン類似度検索。ブロック読みでメモリを一定に保つ。 */
  vectorSearch(query, topK = 100, filter = null) {
    if (!this.dims) return [];
    const p = path.join(this.dir, 'vectors.bin');
    if (!fs.existsSync(p)) return [];
    const fd = IndexStore._openFd(p);
    try {
      const dims = this.dims, rowBytes = dims * 4, block = 2048;
      const buf = Buffer.allocUnsafe(rowBytes * block);
      const scores = new Map();
      for (let start = 0; start < this.N; start += block) {
        const count = Math.min(block, this.N - start);
        const read = fs.readSync(fd, buf, 0, rowBytes * count, start * rowBytes);
        if (read <= 0) break;
        const arr = new Float32Array(buf.buffer, buf.byteOffset, (read / 4) | 0);
        for (let r = 0; r < count; r++) {
          const d = start + r;
          if (filter && !filter(this.meta[d])) continue;
          let dot = 0;
          const base = r * dims;
          if (base + dims > arr.length) break;
          for (let k = 0; k < dims; k++) dot += arr[base + k] * query[k];
          scores.set(d, dot);
        }
      }
      return topN(scores, topK);
    } finally { IndexStore._closeFd(fd); }
  }

  stats() {
    const bySource = {};
    for (const m of this.meta) {
      bySource[m.sourceId] = bySource[m.sourceId] || { chunks: 0, docs: new Set(), kinds: {} };
      bySource[m.sourceId].chunks++;
      bySource[m.sourceId].docs.add(m.docId);
      bySource[m.sourceId].kinds[m.kind] = (bySource[m.sourceId].kinds[m.kind] || 0) + 1;
    }
    return {
      builtAt: this.manifest.builtAt,
      indexKey: this.manifest.indexKey,
      chunks: this.N,
      terms: this.manifest.terms,
      dims: this.dims,
      sources: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, { chunks: v.chunks, documents: v.docs.size, kinds: v.kinds }])),
    };
  }
}

function topN(scores, k) {
  const arr = [...scores.entries()];
  arr.sort((a, b) => b[1] - a[1] || a[0] - b[0]); // 同点は idx 昇順 → 決定的
  return arr.slice(0, k).map(([idx, score]) => ({ idx, score }));
}

export async function writeVectors(dir, vectors, dims) {
  const fd = fs.openSync(path.join(dir, 'vectors.bin'), 'w');
  try {
    for (const v of vectors) {
      const f = Float32Array.from(v);
      // 読み出しは dims 固定ストライドなので、長さの違うベクトルを混ぜると以降全部がずれる
      if (f.length !== dims) throw new Error(`ベクトルの次元数が不揃いです (期待 ${dims} / 実際 ${f.length})`);
      fs.writeSync(fd, Buffer.from(f.buffer, f.byteOffset, f.byteLength));
    }
  } finally { fs.closeSync(fd); }
  const mp = path.join(dir, 'manifest.json');
  const m = JSON.parse(await fsp.readFile(mp, 'utf8'));
  m.dims = dims;
  await fsp.writeFile(mp, JSON.stringify(m, null, 2));
}
