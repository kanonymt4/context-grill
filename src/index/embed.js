import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256, retry } from '../util/misc.js';
import { log } from '../util/log.js';
import { guardedFetch } from '../util/egress.js';
import { redactMessage, redactText } from '../util/redact.js';

/**
 * キャッシュの名前空間とキー。provider が違えば別物として扱う。
 * （config.js の indexKey も provider|model|dimensions で区別しており、そちらに揃えている。
 *   同じ model 名・同じ次元数でも openai と openai-compat では別のサーバが返すため、混ぜると危険）
 */
export function embedCacheNamespace(cfg) {
  return `${cfg.provider}-${cfg.model}-${cfg.dimensions}`.replace(/[^\w.-]/g, '_');
}
export function embedCacheKey(cfg, chunkHash) {
  return sha256(`${cfg.provider}|${cfg.model}|${cfg.dimensions}|${chunkHash}`);
}

/** content hash → ベクトル のローカルキャッシュ（再同期時の API コストをゼロにする） */
class EmbedCache {
  constructor(dir, cfg) {
    this.dir = path.join(dir, embedCacheNamespace(cfg));
    this.dims = cfg.dimensions;
    this.idxPath = path.join(this.dir, 'index.json');
    this.binPath = path.join(this.dir, 'vectors.bin');
  }
  async open() {
    await fsp.mkdir(this.dir, { recursive: true });
    this.map = fs.existsSync(this.idxPath) ? JSON.parse(await fsp.readFile(this.idxPath, 'utf8')) : {};
    this.count = Object.keys(this.map).length;
    this.fd = fs.openSync(this.binPath, fs.existsSync(this.binPath) ? 'r+' : 'w+');
  }
  get(hash) {
    const i = this.map[hash];
    if (i === undefined) return null;
    const bytes = this.dims * 4;
    const buf = Buffer.allocUnsafe(bytes);
    fs.readSync(this.fd, buf, 0, bytes, i * bytes);
    return new Float32Array(buf.buffer, buf.byteOffset, this.dims);
  }
  put(hash, vec) {
    if (this.map[hash] !== undefined) return;
    const i = this.count++;
    const f = Float32Array.from(vec);
    fs.writeSync(this.fd, Buffer.from(f.buffer, f.byteOffset, f.byteLength), 0, f.byteLength, i * this.dims * 4);
    this.map[hash] = i;
  }
  async close() {
    await fsp.writeFile(this.idxPath, JSON.stringify(this.map));
    fs.closeSync(this.fd);
  }
}

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * プロバイダごとのリクエストを組み立てる（純関数・ネットワーク非依存）。
 * `inputType` は Voyage 系のみ意味を持つ。文書側は 'document'、検索クエリ側は 'query' を渡す。
 * ここを取り違えると同じベクトル空間に載らず、分離度が実測で 3 割落ちる。
 */
export function buildEmbeddingRequest(cfg, inputs, inputType = 'document') {
  if (cfg.provider === 'voyage') {
    return {
      url: cfg.baseUrl || 'https://api.voyageai.com/v1/embeddings',
      body: { model: cfg.model, input: inputs, input_type: inputType, output_dimension: cfg.dimensions },
    };
  }
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const body = { model: cfg.model, input: inputs };
  if (cfg.dimensions && cfg.provider === 'openai') body.dimensions = cfg.dimensions;
  return { url: `${base}/embeddings`, body };
}

/**
 * 埋め込み API のレスポンスを入力順に並べ直す（純関数）。
 * レスポンス順は仕様上保証されないため、全プロバイダで `data[].index` に従う。
 * index が無いプロバイダでは Array#sort の安定性によりレスポンス順が保たれる。
 */
export function parseEmbeddingResponse(json, expected, dims) {
  const data = json?.data;
  if (!Array.isArray(data)) throw new Error('埋め込み API のレスポンスに data 配列がありません');
  if (expected !== undefined && data.length !== expected) {
    throw new Error(`埋め込み API の応答数が入力数と一致しません (入力 ${expected} / 応答 ${data.length})`);
  }
  const vecs = data.slice().sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)).map((d) => d.embedding);
  // 長さが設定と違うと vectors.bin を固定ストライドで読み書きする側が黙ってずれるので、ここで止める。
  // 設定ミス（モデルの実次元と dimensions の不一致）なのでリトライしても直らない。
  if (dims) {
    for (const v of vecs) {
      if (!Array.isArray(v) || v.length !== dims) {
        throw Object.assign(new Error(
          `埋め込み API が ${Array.isArray(v) ? v.length : '?'} 次元のベクトルを返しました（設定: retrieval.embedding.dimensions=${dims}）\n` +
          `設定値をモデルの実際の次元数に合わせてください。`), { noRetry: true });
      }
    }
  }
  return vecs;
}

async function callEmbeddingApi(cfg, inputs, { inputType = 'document' } = {}) {
  const key = process.env[cfg.apiKeyEnv || 'OPENAI_API_KEY'];
  if (!key) throw Object.assign(new Error(`埋め込み用の環境変数 ${cfg.apiKeyEnv} が未設定です`), { noRetry: true });
  const { url, body } = buildEmbeddingRequest(cfg, inputs, inputType);
  const res = await guardedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }, { purpose: 'embedding' });
  if (!res.ok) throw new Error(redactMessage(`${cfg.provider} embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`));
  return parseEmbeddingResponse(await res.json(), inputs.length, cfg.dimensions);
}

/** チャンク配列 → 正規化済みベクトル配列（キャッシュヒット分は API を呼ばない） */
export async function embedChunks(chunks, cfg, cacheDir, { onProgress, security = {} } = {}) {
  if (cfg.provider === 'none') return null;
  // 埋め込みは「社内ソースの本文を外部 API に送る」操作なので明示同意を必須にする
  if (!security.allowEmbeddingUpload) {
    throw Object.assign(new Error(
      `retrieval.embedding.provider="${cfg.provider}" は資料本文を外部 API (${cfg.baseUrl || cfg.provider}) に送信します。\n` +
      `送信を許可する場合は security.allowEmbeddingUpload=true を明示してください。\n` +
      `送信したくない場合は provider を "none"（BM25 + 用語辞書のみ）にしてください。`), { noRetry: true });
  }
  const cache = new EmbedCache(cacheDir, cfg);
  await cache.open();
  const out = new Array(chunks.length);
  const todo = [];
  for (let i = 0; i < chunks.length; i++) {
    const h = embedCacheKey(cfg, chunks[i].hash);
    const hit = cache.get(h);
    // 外部に出る本文は必ず墨消し済みにする
    if (hit) out[i] = hit; else todo.push({ i, h, text: redactText(chunks[i].text).text.slice(0, 8000) });
  }
  log.info(`埋め込み: キャッシュ ${chunks.length - todo.length} / 新規 ${todo.length}`);
  const batch = cfg.batch || 96;
  try {
    for (let s = 0; s < todo.length; s += batch) {
      const slice = todo.slice(s, s + batch);
      const vecs = await retry(() => callEmbeddingApi(cfg, slice.map((t) => t.text), { inputType: 'document' }), { attempts: 4 });
      for (let k = 0; k < slice.length; k++) {
        const nv = normalize(vecs[k]);
        out[slice[k].i] = nv;
        cache.put(slice[k].h, nv);
      }
      if (onProgress) onProgress(Math.min(s + batch, todo.length), todo.length);
    }
  } finally {
    // 途中で失敗しても、取得できたところまでは hash → オフセットの対応表 (index.json) に確定させる。
    // ここを通らないとベクトル本体は書けていても対応表が失われ、次回 sync がゼロからになる。
    await cache.close();
  }
  return out;
}

export async function embedQuery(text, cfg) {
  if (cfg.provider === 'none') return null;
  const [v] = await retry(() => callEmbeddingApi(cfg, [text.slice(0, 8000)], { inputType: 'query' }), { attempts: 3 });
  return normalize(v);
}
