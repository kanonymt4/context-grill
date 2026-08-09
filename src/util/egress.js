import fs from 'node:fs';
import path from 'node:path';
import { redactMessage } from './redact.js';
import { log } from './log.js';

/**
 * 外部通信の単一ゲート。
 * すべての送信（GitHub / Atlassian / 埋め込み API / LLM API / git）はここを通る。
 * 設定から導出したホスト許可リストに無い宛先へは、たとえコード上に URL があっても送れない。
 */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

let POLICY = null;

function hostOf(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return null; }
}

export function initEgress(config) {
  const sec = config.security || {};
  const allow = new Set();
  const reasons = [];
  const add = (u, why) => {
    const h = typeof u === 'string' && u.includes('://') ? hostOf(u) : (u ? String(u).toLowerCase() : null);
    if (!h) return;
    if (!allow.has(h)) reasons.push({ host: h, why });
    allow.add(h);
  };

  for (const s of config.sources || []) {
    if (s.type === 'github') {
      if (!s.path) {
        add(s.host || 'github.com', `source:${s.id} (git)`);
        add(s.apiBaseUrl || 'https://api.github.com', `source:${s.id} (api)`);
      }
    } else if (s.type === 'confluence' || s.type === 'jira') {
      add(s.baseUrl, `source:${s.id}`);
    }
  }
  const llm = config.llm || {};
  if (llm.provider === 'anthropic') add(llm.baseUrl || 'https://api.anthropic.com', 'llm');
  else if (llm.provider === 'openai') add(llm.baseUrl || 'https://api.openai.com', 'llm');
  else if (llm.provider === 'openai-compat' && llm.baseUrl) add(llm.baseUrl, 'llm(compat)');

  const emb = config.retrieval?.embedding || {};
  if (emb.provider === 'openai') add(emb.baseUrl || 'https://api.openai.com', 'embedding');
  else if (emb.provider === 'voyage') add(emb.baseUrl || 'https://api.voyageai.com', 'embedding');
  else if (emb.provider === 'openai-compat' && emb.baseUrl) add(emb.baseUrl, 'embedding(compat)');

  for (const h of sec.allowHosts || []) add(h, 'security.allowHosts');

  POLICY = {
    mode: sec.networkMode || 'normal',
    allow,
    reasons,
    auditPath: sec.auditLog === false ? null : path.join(config.workspaceDir, 'egress.log'),
    counters: { requests: 0, bytesSent: 0, byHost: {} },
  };
  return POLICY;
}

export function getPolicy() { return POLICY; }

export function egressPlan() {
  if (!POLICY) return { mode: 'uninitialized', hosts: [] };
  return {
    mode: POLICY.mode,
    hosts: POLICY.reasons.map((r) => ({ host: r.host, reason: r.why })),
    auditLog: POLICY.auditPath,
  };
}

class EgressBlocked extends Error {
  constructor(msg) { super(msg); this.name = 'EgressBlocked'; this.noRetry = true; }
}

/** 送信前チェック。違反時は必ず例外（フォールバックで素通りさせない）。 */
export function assertAllowed({ url, host, method = 'GET', purpose }) {
  if (!POLICY) throw new EgressBlocked('外部通信ポリシーが初期化されていません（内部エラー）');
  const h = host ? String(host).toLowerCase() : hostOf(url);
  if (POLICY.mode === 'offline') {
    throw new EgressBlocked(`オフラインモードのため外部通信を拒否しました (${purpose}: ${h}). security.networkMode を "normal" にするか、--offline を外してください。`);
  }
  if (!h) throw new EgressBlocked(`宛先ホストを解決できません: ${url}`);
  if (!POLICY.allow.has(h)) {
    throw new EgressBlocked(
      `許可されていない宛先への送信をブロックしました: ${h} (${purpose})\n` +
      `許可済み: ${[...POLICY.allow].join(', ') || '(なし)'}\n` +
      `意図した通信であれば security.allowHosts に追加してください。`
    );
  }
  const m = String(method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(m)) {
    throw new EgressBlocked(`このツールは参照系メソッドのみ許可しています（${m} は禁止）。宛先: ${h}`);
  }
  return h;
}

function audit(entry) {
  if (!POLICY?.auditPath) return;
  try {
    fs.appendFileSync(POLICY.auditPath, JSON.stringify(entry) + '\n');
  } catch { /* 監査ログの失敗で本処理は止めない */ }
}

/** 唯一の fetch ラッパー。src/ 内で fetch() を直接呼ぶことは禁止。 */
export async function guardedFetch(url, init = {}, { purpose = 'unknown', timeoutMs = 60000 } = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const host = assertAllowed({ url, method, purpose });
  const bytes = init.body ? Buffer.byteLength(typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : 0;
  POLICY.counters.requests++;
  POLICY.counters.bytesSent += bytes;
  POLICY.counters.byHost[host] = POLICY.counters.byHost[host] || { requests: 0, bytesSent: 0 };
  POLICY.counters.byHost[host].requests++;
  POLICY.counters.byHost[host].bytesSent += bytes;

  const started = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  let status = 0;
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    status = res.status;
    return res;
  } finally {
    clearTimeout(to);
    // クエリ文字列は記録しない（トークンが載る可能性があるため）
    let pathOnly = url;
    try { const u = new URL(url); pathOnly = u.origin + u.pathname; } catch { /* noop */ }
    audit({ ts: new Date().toISOString(), purpose, method, url: pathOnly, bytesSent: bytes, status, ms: Date.now() - started });
  }
}

/** git など fetch 以外の経路の記録用 */
export function auditExternal({ purpose, host, detail, bytesSent = 0 }) {
  POLICY.counters.requests++;
  POLICY.counters.byHost[host] = POLICY.counters.byHost[host] || { requests: 0, bytesSent: 0 };
  POLICY.counters.byHost[host].requests++;
  audit({ ts: new Date().toISOString(), purpose, method: 'GIT', url: `https://${host}`, detail: redactMessage(detail || ''), bytesSent, status: 0 });
}

export function egressSummary() {
  return POLICY ? { ...POLICY.counters, mode: POLICY.mode } : null;
}

export { EgressBlocked };
