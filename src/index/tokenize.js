// 依存ゼロのトークナイザ。
//  - 英数識別子: camelCase / snake_case を部分語にも展開（コード検索の再現率）
//  - 日本語など CJK: 形態素解析器なしで 1-gram + 2-gram（形態素解析器への依存を避ける）
const TOKEN_RE = /[A-Za-z][A-Za-z0-9_$]*|[0-9]+(?:\.[0-9]+)*|[぀-ヿ㐀-䶿一-鿿豈-﫿]+/g;
const CJK_TEST = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

const STOP = new Set([
  'the','a','an','of','to','and','or','in','on','for','is','are','be','it','this','that','with','as','by','at','from','we','you','i','not','if','then','else','do','does','can','will','was','were','has','have','had','but','so','than','into','via','use','used','using',
  'する','した','して','ある','いる','これ','それ','その','この','ため','こと','もの','など','よう','から','まで','です','ます','ない','なる','により','および','または',
]);

export function tokenize(text, { stopwords = false } = {}) {
  const out = [];
  if (!text) return out;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const t = m[0];
    if (CJK_TEST.test(t[0])) {
      for (let i = 0; i < t.length; i++) {
        const uni = t[i];
        if (!stopwords || !STOP.has(uni)) out.push(uni);
        if (i + 1 < t.length) {
          const bi = t.slice(i, i + 2);
          if (!stopwords || !STOP.has(bi)) out.push(bi);
        }
      }
      continue;
    }
    const low = t.toLowerCase();
    if (low.length >= 2 && (!stopwords || !STOP.has(low))) out.push(low);
    if (t.length > 3) {
      for (const part of splitIdentifier(t)) {
        if (part.length >= 2 && part !== low && (!stopwords || !STOP.has(part))) out.push(part);
      }
    }
  }
  return out;
}

export function splitIdentifier(t) {
  return t
    .replace(/[_$]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/** 検索クエリ用: ストップワード除去 + 重み（出現回数）付き */
export function queryTerms(text) {
  const toks = tokenize(text, { stopwords: true });
  const map = new Map();
  for (const t of toks) map.set(t, (map.get(t) || 0) + 1);
  return map;
}
