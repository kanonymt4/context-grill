import crypto from 'node:crypto';

export function sha256(input) {
  const s = typeof input === 'string' ? input : stableStringify(input);
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
export function shortHash(input, n = 12) { return sha256(input).slice(0, n); }

/** キー順を固定した JSON 文字列化（設定ハッシュ・プロンプトハッシュの再現性のため） */
export function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 依存ゼロの簡易 glob → RegExp（`**`, `*`, `?`, `{a,b}` に対応） */
export function globToRegExp(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:[^/]*\\/)*'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i += 1; continue;
    }
    if (c === '?') { re += '[^/]'; i += 1; continue; }
    if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > -1) {
        const opts = glob.slice(i + 1, end).split(',').map((o) => o.split('').map(escapeRe).join(''));
        re += '(?:' + opts.join('|') + ')';
        i = end + 1; continue;
      }
    }
    re += escapeRe(c); i += 1;
  }
  return new RegExp('^' + re + '$');
}

const globCache = new Map();
export function matchGlob(p, pattern) {
  let r = globCache.get(pattern);
  if (!r) { r = globToRegExp(pattern); globCache.set(pattern, r); }
  return r.test(p);
}

/** include/exclude 判定。include が空なら全件対象。exclude が優先。 */
export function isIncluded(p, include = [], exclude = []) {
  for (const ex of exclude) if (matchGlob(p, ex)) return false;
  if (!include || include.length === 0) return true;
  for (const inc of include) if (matchGlob(p, inc)) return true;
  return false;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function uniqBy(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = keyFn(x); if (seen.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
export function nowIso() { return new Date().toISOString(); }

/** 深いマージ（配列は置換） */
export function deepMerge(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
  if (typeof base !== 'object' || base === null) return over ?? base;
  if (typeof over !== 'object' || over === null) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

/** 指数バックオフ付きリトライ */
export async function retry(fn, { attempts = 4, baseMs = 600, onRetry } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(i); } catch (e) {
      last = e;
      if (e && e.noRetry) throw e;
      if (i === attempts - 1) break;
      const wait = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 200);
      if (onRetry) onRetry(e, i, wait);
      await sleep(wait);
    }
  }
  throw last;
}
