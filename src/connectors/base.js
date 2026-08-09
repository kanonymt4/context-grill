import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256, retry } from '../util/misc.js';
import { log } from '../util/log.js';
import { guardedFetch } from '../util/egress.js';
import { redactMessage } from '../util/redact.js';
import { isSensitivePath } from '../util/sensitive.js';

export const CODE_EXT = new Set(['js','mjs','cjs','jsx','ts','tsx','py','rb','go','rs','java','kt','kts','scala','c','h','cc','cpp','hpp','cs','php','swift','m','mm','sh','bash','zsh','sql','graphql','proto','tf','hcl','vue','svelte','dart','ex','exs','erl','pl','lua','r','groovy']);
export const DOC_EXT = new Set(['md','markdown','mdx','rst','txt','adoc']);
export const CONF_EXT = new Set(['json','yaml','yml','toml','ini','env','xml','properties','gradle','cfg','conf']);

export function classify(p) {
  const base = path.basename(p).toLowerCase();
  const ext = (p.split('.').pop() || '').toLowerCase();
  if (['dockerfile','makefile','jenkinsfile','procfile'].includes(base)) return { kind: 'config', lang: base };
  if (CODE_EXT.has(ext)) return { kind: 'code', lang: ext };
  if (DOC_EXT.has(ext)) return { kind: 'doc', lang: ext };
  if (CONF_EXT.has(ext)) return { kind: 'config', lang: ext };
  return { kind: 'other', lang: ext || 'txt' };
}

export function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * 生ドキュメント（チャンク前）の正規形。
 * 索引はこのキャッシュから毎回決定的に再構築されるので、
 * 同期タイミングが違っても同じキャッシュなら同じ索引になる。
 */
export function makeDoc({ sourceId, sourceType, docPath, title, kind, lang, text, url, version, meta }) {
  return {
    docId: `${sourceId}:${docPath}`,
    sourceId, sourceType,
    path: docPath,
    title: title || docPath,
    kind: kind || 'other',
    lang: lang || 'txt',
    url: url || null,
    version: version || null,
    hash: sha256(text),
    meta: meta || {},
    text,
  };
}

export async function writeDocsCache(dir, docs, state) {
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, 'docs.jsonl.tmp');
  const out = fs.createWriteStream(tmp);
  for (const d of docs) out.write(JSON.stringify(d) + '\n');
  await new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); out.end(); });
  await fsp.rename(tmp, path.join(dir, 'docs.jsonl'));
  await fsp.writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

export async function readDocsCache(dir) {
  const f = path.join(dir, 'docs.jsonl');
  if (!fs.existsSync(f)) return [];
  const text = await fsp.readFile(f, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 破損行はスキップ */ }
  }
  return out;
}

export async function readState(dir) {
  const f = path.join(dir, 'state.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return null; }
}

export function requireEnv(name, hint) {
  const v = process.env[name];
  if (!v) {
    const e = new Error(`環境変数 ${name} が未設定です。${hint || ''}`);
    e.noRetry = true;
    throw e;
  }
  return v;
}

/** 索引対象にしてよいパスか（include 設定より強い無条件の拒否リスト） */
export function isIndexable(p, security = {}) {
  if (security.denySensitivePaths === false) return true;
  return !isSensitivePath(p, security.extraDenyPaths || []);
}

export async function httpJson(url, opts = {}) {
  const purpose = opts.purpose || 'http';
  return retry(async () => {
    const res = await guardedFetch(url, opts, { purpose, timeoutMs: opts.timeoutMs ?? 60000 });
    const body = await res.text();
    if (!res.ok) {
      // 応答本文・URL にトークンが混ざる可能性があるため必ず墨消しする
      const safeUrl = url.split('?')[0];
      const err = new Error(redactMessage(`HTTP ${res.status} ${res.statusText} for ${safeUrl}\n${body.slice(0, 600)}`));
      if (res.status === 401 || res.status === 403 || res.status === 404) err.noRetry = res.status !== 403;
      err.status = res.status;
      throw err;
    }
    return body ? JSON.parse(body) : null;
  }, { onRetry: (e, i, w) => log.warn(`再試行 ${i + 1}: ${redactMessage(e.message).split('\n')[0]} (${w}ms待機)`) });
}
