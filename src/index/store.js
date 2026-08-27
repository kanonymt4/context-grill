import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tokenize } from './tokenize.js';

const SHARDS = 32;
const FORMAT_VERSION = 2;   // 2: ファイル名に世代番号を持たせた（1 とは互換性がない）

const pad = (g) => String(g).padStart(4, '0');

/**
 * 索引ファイルの置き場所。1 世代ぶんのパスをまとめて返す。
 *
 * ファイル名に世代番号を入れ、一度書いたファイルは二度と変更しない。読み手が触るのは
 * 常に公開済みの世代だけなので、書き込みの途中に開いても新旧が混ざらない。
 * 宛先が毎回まだ存在しない名前になるので、開かれているファイルを rename の宛先にできない
 * Windows でも詰まらない（CLAUDE.md の実測を参照）。
 */
export function layout(dir, gen) {
  const g = pad(gen);
  return {
    gen,
    manifest: path.join(dir, `manifest.${g}.json`),
    manifestTmp: path.join(dir, `manifest.${g}.json.tmp`),
    meta: path.join(dir, `docs.meta.${g}.json`),
    df: path.join(dir, `df.${g}.json`),
    lens: path.join(dir, `lens.${g}.json`),
    docs: path.join(dir, `docs.${g}.txt`),
    vectors: path.join(dir, `vectors.${g}.bin`),
    postingsDir: path.join(dir, 'postings'),
    postings: (i) => path.join(dir, 'postings', `${g}.${i}.json`),
  };
}

const MANIFEST_RE = /^manifest\.(\d{4})\.json$/;

/**
 * 公開済みの最大世代を返す。無ければ null。
 *
 * manifest.NNNN.json の存在がその世代の完成を意味する（他のファイルを全部書き終えてから
 * 未使用の名前へ rename して公開するため）。数を数える必要はない。
 */
export function latestGen(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  let max = null;
  for (const n of names) {
    const m = MANIFEST_RE.exec(n);
    if (!m) continue;
    const g = Number(m[1]);
    if (max === null || g > max) max = g;
  }
  return max;
}

/** 指定した世代以外のファイルを消す。消せなくても致命的ではないので握り潰す。 */
async function pruneGenerations(dir, keep) {
  const kill = async (base, name) => {
    const m = /^(?:manifest|docs\.meta|df|lens)\.(\d{4})\.json(?:\.tmp)?$|^docs\.(\d{4})\.txt$|^vectors\.(\d{4})\.bin$/.exec(name);
    const g = m && (m[1] ?? m[2] ?? m[3]);
    if (g === undefined || g === null || Number(g) === keep) return;
    try { await fsp.unlink(path.join(base, name)); } catch (e) { /* 使用中なら次回に回す */ }
  };
  try {
    await Promise.all((await fsp.readdir(dir)).map((n) => kill(dir, n)));
  } catch (e) { /* ディレクトリが無い */ }
  const pd = path.join(dir, 'postings');
  try {
    await Promise.all((await fsp.readdir(pd)).map(async (n) => {
      const m = /^(\d{4})\.\d{1,2}\.json$/.exec(n);
      if (!m || Number(m[1]) === keep) return;
      try { await fsp.unlink(path.join(pd, n)); } catch (e) { /* 同上 */ }
    }));
  } catch (e) { /* postings が無い */ }
}

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
    this.L = null;      // 世代が決まる start() で入る
    this.meta = [];
    this.postings = new Map();
    this.lens = [];
    this.off = 0;
    this.fd = null;
  }
  async start() {
    await fsp.mkdir(path.join(this.dir, 'postings'), { recursive: true });
    this.L = layout(this.dir, (latestGen(this.dir) ?? 0) + 1);
    // 世代番号つきの名前はまだ誰も開いていないので、tmp を経由せず直接書ける
    this.fd = fs.openSync(this.L.docs, 'w');
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
  /**
   * この世代のファイルを全部書く。publish: false なら manifest は .tmp のままにする。
   *
   * ベクトルは索引本体より後に決まる（埋め込みは時間もお金もかかる）。公開してから
   * manifest に dims を書き足すと、公開済みのファイルを上書きすることになり、
   * 読み手が中途半端な内容を掴む。だから公開を遅らせられるようにしてある。
   */
  async finish(extra = {}, { publish = true } = {}) {
    fs.closeSync(this.fd);
    const shards = Array.from({ length: SHARDS }, () => ({}));
    const df = {};
    for (const [term, arr] of this.postings) {
      shards[shardOf(term)][term] = arr;
      df[term] = arr.length / 2;
    }
    await Promise.all(shards.map((s, i) => fsp.writeFile(this.L.postings(i), JSON.stringify(s))));
    await fsp.writeFile(this.L.df, JSON.stringify(df));
    await fsp.writeFile(this.L.lens, JSON.stringify(this.lens));
    await fsp.writeFile(this.L.meta, JSON.stringify(this.meta));
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
    await fsp.writeFile(this.L.manifestTmp, JSON.stringify(manifest, null, 2));
    this.postings.clear();
    if (publish) await this.publish();
    return manifest;
  }

  /** manifest を未使用の名前へ rename して公開する。rename は原子的なので途中が見えない。 */
  async publish() {
    await fsp.rename(this.L.manifestTmp, this.L.manifest);
    await pruneGenerations(this.dir, this.L.gen);
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
   * IndexStore.open() が 1 回走るごとに増える。同じストアを開き直していないこと
   * ——とくに MCP サーバーが run_task 経由でストアを二重に開いていないこと——を
   * 表明するために使う（UNVERIFIED-008）。
   *
   * close() 後の読み取りの検知には使えない。fd は open() の時点で確保しており、
   * close() 後に読むと開き直さずに例外になるため、この値は増えない。所有権違反は
   * 「閉じた後は読めない」ことで直接捕まえる（test/security.test.js を参照）。
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

  constructor(dir) { this.dir = dir; this.L = null; this._shards = new Map(); this._fd = null; this._vfd = null; }

  static exists(dir) { return latestGen(dir) !== null; }

  static async open(dir, opts = {}) {
    const { postings: loadPostings = true } = opts;
    const s = new IndexStore(dir);
    const gen = latestGen(dir);
    if (gen === null) {
      // 世代番号を持たない古い索引（formatVersion 1）はここに来る。読まずに作り直させる。
      const old = fs.existsSync(path.join(dir, 'manifest.json'));
      throw new Error(old
        ? `索引の形式が変わりました (${dir})。\`context-grill sync\` で作り直してください。`
        : `索引がありません (${dir})。先に \`context-grill sync\` を実行してください。`);
    }
    s.L = layout(dir, gen);
    s.manifest = JSON.parse(await fsp.readFile(s.L.manifest, 'utf8'));
    if (s.manifest.formatVersion !== FORMAT_VERSION) {
      throw new Error(`索引の形式が違います (${dir})。期待 ${FORMAT_VERSION} / 実際 ${s.manifest.formatVersion}。\`context-grill sync\` で作り直してください。`);
    }
    s.meta = JSON.parse(await fsp.readFile(s.L.meta, 'utf8'));
    s.df = JSON.parse(await fsp.readFile(s.L.df, 'utf8'));
    s.lens = JSON.parse(await fsp.readFile(s.L.lens, 'utf8'));
    if (loadPostings) {
      // postings も open() 時に読み切る。docs.txt は fd 保持で古い実体を読み続けるのに対し、
      // 遅延読み込みの postings はパス指定で新しい実体を読む。この非対称のため、索引を
      // 作り直すと meta と doc id の世代がずれ、store.meta[idx] が undefined になる。
      s._shards = new Map(await Promise.all(Array.from({ length: SHARDS }, async (_, i) => {
        const f = s.L.postings(i);
        try {
          return [i, JSON.parse(await fsp.readFile(f, 'utf8'))];
        } catch (e) {
          // 欠損や破損を黙って空シャードとして扱うと、その語だけ静かに 0 ヒットになる。
          throw new Error(`索引が壊れています (${dir})。${path.basename(f)} を読めません: ${e.message}\n\`context-grill sync\` で作り直してください。`);
        }
      })));
    } else {
      // postings 未ロード。検索しないコマンド（status 等）向け。触ると postings() で明確なエラーになる。
      s._shards = null;
    }
    s.N = s.manifest.N;
    s.avgdl = s.manifest.avgdl || 1;
    s.dims = s.manifest.dims || 0;

    // docs / vectors の fd は open() の時点で確保する。遅延オープンにすると、索引を
    // 作り直した後に初めて触った時点では旧世代のファイル名が pruneGenerations() で
    // もう消えており、docs は ENOENT、vectors は例外を出さずに null / 0 件になる。
    // fd を握っていれば unlink 後も実体を読み続けられる（Windows も含めて実測済み。
    // CLAUDE.md の UNVERIFIED-009 を参照）。
    //
    // postings: false でも確保する。分岐を増やすと「どの条件でスナップショットが
    // 保証されるか」が読み手に分からなくなるため、fd 2 本のコストを取る。
    try {
      s._fd = IndexStore._openFd(s.L.docs);
      if (s.dims && fs.existsSync(s.L.vectors)) s._vfd = IndexStore._openFd(s.L.vectors);
    } catch (e) {
      await s.close();
      throw e;
    }
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
    if (!this.dims || this._vfd === null) return null;
    const bytes = this.dims * 4;
    const buf = Buffer.allocUnsafe(bytes);
    fs.readSync(this._vfd, buf, 0, bytes, i * bytes);
    return new Float32Array(buf.buffer, buf.byteOffset, this.dims);
  }

  /** 正規化済みベクトル前提のコサイン類似度検索。ブロック読みでメモリを一定に保つ。 */
  vectorSearch(query, topK = 100, filter = null) {
    if (!this.dims || this._vfd === null) return [];
    const fd = this._vfd; // open() で確保した世代固定の fd。ここで開き直さない
    {
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
    }
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

/**
 * ベクトルを書き、まだ公開していない manifest に dims を書き足す。
 *
 * 公開済みの manifest は書き換えない。公開したファイルを上書きすると、読み手が
 * 中途半端な内容を掴む余地ができるうえ、Windows では開かれていると書けなくなる。
 */
export async function writeVectors(dir, gen, vectors, dims) {
  const L = layout(dir, gen);
  if (!fs.existsSync(L.manifestTmp)) {
    throw new Error(`公開済みの世代にはベクトルを書けません (${L.manifest})。finish(extra, { publish: false }) で公開を遅らせてください。`);
  }
  const fd = fs.openSync(L.vectors, 'w');
  try {
    for (const v of vectors) {
      const f = Float32Array.from(v);
      // 読み出しは dims 固定ストライドなので、長さの違うベクトルを混ぜると以降全部がずれる
      if (f.length !== dims) throw new Error(`ベクトルの次元数が不揃いです (期待 ${dims} / 実際 ${f.length})`);
      fs.writeSync(fd, Buffer.from(f.buffer, f.byteOffset, f.byteLength));
    }
  } finally { fs.closeSync(fd); }
  const mp = L.manifestTmp;
  const m = JSON.parse(await fsp.readFile(mp, 'utf8'));
  m.dims = dims;
  await fsp.writeFile(mp, JSON.stringify(m, null, 2));
}
