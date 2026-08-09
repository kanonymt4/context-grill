const CJK_G = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/g;

/**
 * トークン数の近似見積り。tiktoken 等の追加依存なしで
 * どの環境でも同じ値になる（=予算計算が再現可能）ことを重視。
 * 実測ベース: 英数記号 ≒ 3.7文字/token, 日本語 ≒ 1.05文字/token
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(CJK_G) || []).length;
  const other = s.length - cjk;
  return Math.ceil(cjk * 1.05 + other / 3.7) + 1;
}

/** トークン予算に収まるように末尾を切る */
export function truncateToTokens(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + '\n…(truncated)';
}
