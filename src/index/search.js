import { queryTerms, tokenize } from './tokenize.js';
import { bridgeTerms } from './glossary.js';
import { embedQuery } from './embed.js';

/** Reciprocal Rank Fusion: 異なるスコア尺度を順位だけで融合する（スケール依存がなく再現性が高い） */
export function rrf(lists, k = 60) {
  const acc = new Map();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const { idx } = list[rank];
      acc.set(idx, (acc.get(idx) || 0) + 1 / (k + rank + 1));
    }
  }
  return [...acc.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([idx, score]) => ({ idx, score }));
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
      const val = lambda * rel - (1 - lambda) * div - sameDoc;
      if (val > bestVal) { bestVal = val; best = i; }
    }
    selected.push(pool.splice(best, 1)[0]);
  }
  return selected;
}

/**
 * ハイブリッド検索。BM25（語彙一致・コード識別子に強い）とベクトル（言い換えに強い）を
 * RRF で融合 → 決定的なフィーチャ加点 → MMR で多様化。
 * 埋め込み無効時も BM25 のみで同じ手順が成立する。
 */
export async function hybridSearch(store, opts) {
  const {
    queries, config, filter = null, k, kindPriors = {}, sourcePriority = {},
  } = opts;
  const h = config.retrieval.hybrid;
  const finalK = k ?? h.final;
  const embedCfg = config.retrieval.embedding;
  const lists = [];
  const perQuery = h.perQueryTop ?? 60;
  const allTerms = new Map();

  for (const q of queries) {
    const terms = queryTerms(q);
    // 日英の語彙ギャップを静的辞書で橋渡し（埋め込み無効でも日本語→英語コードに届く）
    if (config.retrieval.glossaryBridge !== false) {
      for (const [t, w] of bridgeTerms(q)) if (!terms.has(t)) terms.set(t, w);
    }
    for (const [t, c] of terms) allTerms.set(t, (allTerms.get(t) || 0) + c);
    lists.push(store.bm25(terms, perQuery, filter));
    if (store.dims && embedCfg.provider !== 'none') {
      try {
        const qv = await embedQuery(q, embedCfg);
        if (qv) lists.push(store.vectorSearch(qv, perQuery, filter));
      } catch { /* 埋め込み失敗時は BM25 のみで継続（品質は落ちるが動作は保証） */ }
    }
  }

  let fused = rrf(lists, h.rrfK);
  const boosts = config.retrieval.boosts;
  fused = fused.map((r) => {
    const m = store.meta[r.idx];
    let s = r.score;
    const pathTokens = tokenize(`${m.path} ${m.title}`);
    s += boosts.pathMatch * overlapRatio(allTerms, pathTokens) * (1 / (h.rrfK + 1)) * 30;
    s += (boosts.kindPrior * (kindPriors[m.kind] ?? 0)) * (1 / (h.rrfK + 1)) * 30;
    s += (boosts.sourcePriority * (sourcePriority[m.sourceId] ?? 0)) * (1 / (h.rrfK + 1)) * 30;
    return { ...r, score: s };
  }).sort((a, b) => b.score - a.score || a.idx - b.idx);

  const picked = mmrSelect(store, fused, { lambda: h.mmrLambda, k: finalK, useVectors: Boolean(store.dims) });
  return picked.map((r, i) => ({ rank: i + 1, score: r.score, ...store.chunkAt(r.idx) }));
}
