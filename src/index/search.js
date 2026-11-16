import { queryTerms, tokenize } from './tokenize.js';
import { bridgeTerms } from './glossary.js';
import { embedQuery } from './embed.js';
import { log } from '../util/log.js';
import { redactMessage } from '../util/redact.js';

/**
 * 正規化したスコアの平均で融合する（CombSUM をリスト数で割ったもの）。
 *
 * 以前は RRF（順位だけで融合）だった。RRF は「BM25 で 15.7 対 1.0」と「15.7 対 15.6」を区別できず、
 * 隣り合う順位の差（1/61 − 1/62 ≒ 0.00026）より大きい加点で順位が入れ替わっていた。
 * ここでは各リストのスコアの大きさを残す。
 *  - BM25: score / max。0 が「一致なし」という自然な原点なので、比がそのまま意味を持つ
 *  - ベクトル: (score − min) / (max − min)。cos 類似度には自然な原点がなく、無関係な文書でも
 *    0.2〜0.4 程度になるため、max で割るだけでは上位がほぼ同じ値に潰れる
 * 各リストは降順に並んでいる前提（store.bm25 / store.vectorSearch の topN）。
 * 結果は [0, 1]。同点は idx 昇順 → 決定的。
 */
export function fuseScores(lists) {
  const acc = new Map();
  for (const { items, kind } of lists) {
    if (!items.length) continue;
    const max = items[0].score, min = items[items.length - 1].score;
    for (const { idx, score } of items) {
      if (!Number.isFinite(score)) throw new Error(`検索結果のスコアが数値ではありません (idx=${idx})`);
      let v;
      if (kind === 'vector') v = max > min ? (score - min) / (max - min) : 1;
      else v = max > 0 ? score / max : 0;
      acc.set(idx, (acc.get(idx) || 0) + v);
    }
  }
  const n = lists.length || 1;
  return [...acc.entries()].map(([idx, s]) => ({ idx, score: s / n }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);
}

function overlapRatio(aTokens, bTokens) {
  if (!aTokens.size || !bTokens.length) return 0;
  let hit = 0;
  const seen = new Set();
  for (const t of bTokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (aTokens.has(t)) hit++;
  }
  return hit / aTokens.size;
}

/** MMR で「ほぼ同一」とみなす類似度（トークンの Jaccard またはベクトルの内積） */
const DUP_SIM = 0.95;

/** MMR: 関連度と多様性のバランス。同じファイルばかり返るのを防ぎ、トークン当たりの情報量を上げる。 */
function mmrSelect(store, candidates, { lambda = 0.72, k = 24, useVectors = false }) {
  const selected = [];
  const pool = candidates.slice(0, Math.max(k * 6, 60));
  const tokCache = new Map();
  const toks = (i) => {
    if (!tokCache.has(i)) tokCache.set(i, new Set(tokenize(store.textOf(i)).slice(0, 900)));
    return tokCache.get(i);
  };
  const sim = (a, b) => {
    if (useVectors) {
      const va = store.vecAt(a), vb = store.vecAt(b);
      if (va && vb) { let d = 0; for (let i = 0; i < va.length; i++) d += va[i] * vb[i]; return d; }
    }
    const A = toks(a), B = toks(b);
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter || 1);
  };
  const maxScore = pool.length ? pool[0].score : 1;
  while (selected.length < k && pool.length) {
    let best = -1, bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const rel = pool[i].score / (maxScore || 1);
      let div = 0;
      for (const s of selected) div = Math.max(div, sim(pool[i].idx, s.idx));
      // 同一ファイル内の連続チャンクは冗長になりやすいので追加ペナルティ
      const sameDoc = selected.some((s) => store.meta[s.idx].docId === store.meta[pool[i].idx].docId) ? 0.08 : 0;
      // ほぼ同一の本文は、別の本文の候補が残っている間は選ばない（足りなければ後で埋める）。
      // スコアに大きさを残したので、関連度の差が λ の重みだけでは重複の罰を上回ることがある
      const dup = div >= DUP_SIM ? 1 : 0;
      const val = lambda * rel - (1 - lambda) * div - sameDoc - dup;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    selected.push(pool.splice(best, 1)[0]);
  }
  return selected;
}

/**
 * 設定の sources に無いソースのチャンクを常に除く（呼び出し元の filter と AND）。
 * 索引は作成時の設定のまま残るので、sync せずに設定からソースを外すと、外した資料が
 * 警告なしで証拠（LLM への送信対象）に出てしまう。sources を持たない手組みの config では何もしない。
 */
function restrictToConfiguredSources(filter, config) {
  if (!Array.isArray(config?.sources)) return filter;
  const allowed = new Set(config.sources.map((s) => s?.id));
  return (m) => allowed.has(m.sourceId) && (!filter || filter(m));
}

/** 警告済みの (索引の indexKey, 設定の indexKey) の組。プロセスにつき同じ組では 1 回だけ警告する */
const warnedStale = new Set();

/**
 * 索引の作成時と今の設定で indexKey が違えば警告する。indexKey は sources[] 全体・チャンク設定・
 * 埋め込み設定のハッシュなので、priority・include/exclude の変更でも違いが出る（警告は出すぎてよい側に倒す）。
 * 設定側に indexKey が無い手組みの config、manifest の無いストアでは比較しない。
 */
function warnIfIndexStale(store, config) {
  const cfgKey = config?.indexKey;
  const idxKey = store?.manifest?.indexKey;
  if (!cfgKey || !idxKey || cfgKey === idxKey) return;
  const pair = `${idxKey}|${cfgKey}`;
  if (warnedStale.has(pair)) return;
  warnedStale.add(pair);
  log.warn('設定が索引の作成後に変わっています（sources の priority・include/exclude・埋め込み設定などの変更でも出ます）。'
    + '`context-grill sync` で索引を作り直してください。それまでは、設定から外したソースは検索から除きますが、'
    + 'exclude / extraDenyPaths で除外したファイルなど、索引に残った資料は検索結果に出ることがあります');
}

/** 加点の倍率の下限（正の値。ソース内の順位が常に保たれる最小の変更） */
const MIN_FACTOR = 0.01;

/**
 * ハイブリッド検索。BM25（語彙一致・コード識別子に強い）とベクトル（言い換えに強い）を
 * 正規化スコアで融合（fuseScores）→ 決定的なフィーチャ補正（乗法）→ MMR で多様化。
 * 埋め込み無効時も BM25 のみで同じ手順が成立する。
 */
export async function hybridSearch(store, opts) {
  const {
    queries, config, k, kindPriors = {}, sourcePriority = {},
  } = opts;
  warnIfIndexStale(store, config);
  const filter = restrictToConfiguredSources(opts.filter ?? null, config);
  const h = config.retrieval.hybrid;
  const finalK = k ?? h.final;
  const embedCfg = config.retrieval.embedding;
  const lists = [];
  const perQuery = h.perQueryTop ?? 60;
  const allTerms = new Map();
  let embedWarned = false;
  let consentWarned = false;
  const embedDenied = config.security?.allowEmbeddingUpload !== true;

  for (const q of queries) {
    const terms = queryTerms(q);
    // 日英の語彙ギャップを静的辞書で橋渡し（埋め込み無効でも日本語→英語コードに届く）
    if (config.retrieval.glossaryBridge !== false) {
      for (const [t, w] of bridgeTerms(q)) if (!terms.has(t)) terms.set(t, w);
    }
    for (const [t, c] of terms) allTerms.set(t, (allTerms.get(t) || 0) + c);
    lists.push({ kind: 'bm25', items: store.bm25(terms, perQuery, filter) });
    if (store.dims && embedCfg.provider !== 'none' && embedDenied) {
      // クエリ文は利用者の調査内容で、外部 API へ送るデータ。チャンク埋め込みと同じ同意（既定は禁止）に従う
      if (!consentWarned) {
        consentWarned = true;
        log.warn('クエリ埋め込みは送りません（security.allowEmbeddingUpload が true ではないため）。BM25 のみで検索します');
      }
    } else if (store.dims && embedCfg.provider !== 'none') {
      try {
        const qv = await embedQuery(q, embedCfg);
        if (qv) lists.push({ kind: 'vector', items: store.vectorSearch(qv, perQuery, filter) });
      } catch (e) {
        // 埋め込み失敗時は BM25 のみで継続する（動作は保証）。ただし順位が変わり得るので、1 回の検索につき 1 回だけ知らせる
        if (!embedWarned) {
          embedWarned = true;
          const first = redactMessage(String(e?.message ?? e)).split('\n')[0];
          log.warn(`クエリ埋め込みを使えないため BM25 のみで検索します: ${first}`);
        }
      }
    }
  }

  // 加点は乗法の補正にする。スコアの比を 1 + Σ(係数 × 特徴) 倍しか動かせないので、
  // 僅差の順位付けには効き、BM25 が桁違いに強い文書を追い越すことはない。
  const boosts = config.retrieval.boosts;
  const fused = fuseScores(lists).map((r) => {
    const m = store.meta[r.idx];
    const pathTokens = tokenize(`${m.path} ${m.title}`);
    // priority が極端に負だと倍率が 0 以下になり、関連度の高いチャンクほど下に来てしまう
    // （MMR の rel = score / maxScore も符号が反転する）。倍率に正の下限を置いて、順位を保つ
    const factor = Math.max(MIN_FACTOR, 1
      + boosts.pathMatch * overlapRatio(allTerms, pathTokens)
      + boosts.kindPrior * (kindPriors[m.kind] ?? 0)
      + boosts.sourcePriority * (Object.hasOwn(sourcePriority, m.sourceId) ? (sourcePriority[m.sourceId] ?? 0) : 0));
    // 補正値が NaN などだと、スコアが黙って壊れて順位が変わる（fuseScores の検査は補正より前にしかない）
    if (!Number.isFinite(factor)) throw new Error(`検索スコアの補正値が数値ではありません (idx=${r.idx})。sources[].priority と retrieval.boosts.* を確認してください`);
    return { ...r, score: r.score * factor };
  }).sort((a, b) => b.score - a.score || a.idx - b.idx);

  const picked = mmrSelect(store, fused, { lambda: h.mmrLambda, k: finalK, useVectors: Boolean(store.dims) });
  return picked.map((r, i) => ({ rank: i + 1, score: r.score, ...store.chunkAt(r.idx) }));
}
