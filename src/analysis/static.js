import { scanDocument } from './rules.js';
import { estimateTokens } from '../util/tokens.js';

const SEV_ORDER = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** リポジトリ横断の決定的スキャン */
export function scanAll(docs, opts = {}) {
  const findings = [];
  for (const d of docs) findings.push(...scanDocument(d, opts));
  findings.sort((a, b) =>
    SEV_ORDER[b.severity] - SEV_ORDER[a.severity] ||
    a.ruleId.localeCompare(b.ruleId) || a.path.localeCompare(b.path) || a.line - b.line);
  return findings;
}

/** 依存関係・プロジェクト構成の事実抽出（推測を挟まない機械的な観測値） */
export function projectFacts(docs) {
  const facts = [];
  const byPath = new Map(docs.map((d) => [`${d.sourceId}:${d.path}`, d]));
  for (const d of docs) {
    const base = d.path.split('/').pop();
    if (base === 'package.json') {
      try {
        const pkg = JSON.parse(d.text);
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const loose = Object.entries(deps).filter(([, v]) => /^(\*|latest|>=?)/.test(String(v)));
        facts.push({ kind: 'deps', sourceId: d.sourceId, path: d.path, url: d.url,
          detail: `name=${pkg.name ?? '?'} / dependencies=${Object.keys(pkg.dependencies || {}).length} / devDependencies=${Object.keys(pkg.devDependencies || {}).length} / engines=${JSON.stringify(pkg.engines ?? null)}` });
        if (loose.length) {
          facts.push({ kind: 'deps-risk', sourceId: d.sourceId, path: d.path, url: d.url,
            detail: `バージョン範囲が緩い依存: ${loose.map(([k, v]) => `${k}@${v}`).join(', ')}` });
        }
        const hasLock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].some((f) =>
          byPath.has(`${d.sourceId}:${d.path.replace(/package\.json$/, f)}`));
        facts.push({ kind: 'lockfile', sourceId: d.sourceId, path: d.path, url: d.url,
          detail: hasLock ? 'lockfile あり' : 'lockfile が索引内に見つからない（除外設定または未コミット）' });
        if (pkg.scripts) {
          facts.push({ kind: 'scripts', sourceId: d.sourceId, path: d.path, url: d.url,
            detail: `npm scripts: ${Object.keys(pkg.scripts).join(', ')}` });
        }
      } catch { /* JSON が壊れている場合は事実として扱わない */ }
    }
    if (/(^|\/)\.env(\.|$)/.test(d.path) && !/\.example|\.sample|\.template/.test(d.path)) {
      facts.push({ kind: 'secret-file', sourceId: d.sourceId, path: d.path, url: d.url,
        detail: '.env が索引対象に含まれている（コミットされている可能性）' });
    }
    if (/(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i.test(d.path)) {
      const runsAsRoot = !/^\s*USER\s+(?!root)/mi.test(d.text);
      facts.push({ kind: 'container', sourceId: d.sourceId, path: d.path, url: d.url,
        detail: `コンテナ定義。USER 指定${runsAsRoot ? 'なし（root 実行の可能性）' : 'あり'}` });
    }
    if (/(^|\/)(\.github\/workflows\/.*\.ya?ml|\.gitlab-ci\.yml|Jenkinsfile)$/i.test(d.path)) {
      facts.push({ kind: 'ci', sourceId: d.sourceId, path: d.path, url: d.url, detail: 'CI 定義ファイル' });
    }
  }
  return facts;
}

/** ルーティング / 公開エンドポイントの機械的抽出（仕様整理・攻撃面把握に使う） */
export function extractEndpoints(docs, limit = 300) {
  const out = [];
  const patterns = [
    { re: /\b(?:app|router|api)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/g, fw: 'express' },
    { re: /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/g, fw: 'nest/spring' },
    { re: /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g, fw: 'fastapi/flask' },
    { re: /\b(?:r|router|mux)\.(?:HandleFunc|Handle)\s*\(\s*"([^"]+)"/g, fw: 'go' },
    { re: /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gm, fw: 'rails' },
  ];
  for (const d of docs) {
    if (d.kind !== 'code') continue;
    const lines = d.text.split('\n');
    for (const { re, fw } of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(d.text)) !== null) {
        const before = d.text.slice(0, m.index);
        const line = before.split('\n').length;
        const method = (m[2] !== undefined ? m[1] : 'ANY').toUpperCase();
        const route = m[2] !== undefined ? m[2] : m[1];
        out.push({ method, route, framework: fw, sourceId: d.sourceId, path: d.path, line,
          url: d.url && d.sourceType === 'github' ? `${d.url}#L${line}` : d.url,
          snippet: (lines[line - 1] || '').trim().slice(0, 200) });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** 静的事実 → LLM へ渡すテキスト（トークン予算内） */
export function renderStaticFacts({ findings = [], facts = [], endpoints = [] }, budgetTokens) {
  const lines = [];
  const push = (s) => lines.push(s);
  if (findings.length) {
    push('## 静的解析の検出（機械的検出・LLM 非依存）');
    for (const f of findings) {
      push(`- [${f.severity}] ${f.ruleId} ${f.title} @ ${f.sourceId}/${f.path}:${f.line}${f.cwe ? ` (${f.cwe})` : ''}`);
      push(`  > ${f.snippet}`);
    }
  }
  if (facts.length) {
    push('');
    push('## プロジェクト構成の観測値');
    for (const f of facts) push(`- [${f.kind}] ${f.sourceId}/${f.path}: ${f.detail}`);
  }
  if (endpoints.length) {
    push('');
    push('## 抽出されたエンドポイント');
    for (const e of endpoints) push(`- ${e.method} ${e.route} @ ${e.sourceId}/${e.path}:${e.line} (${e.framework})`);
  }
  let text = lines.join('\n');
  while (estimateTokens(text) > budgetTokens && lines.length > 10) {
    lines.splice(Math.floor(lines.length * 0.7), Math.ceil(lines.length * 0.1));
    text = lines.join('\n') + '\n…(静的解析結果を予算内に切り詰めました)';
  }
  return text;
}

export function summarize(findings) {
  const bySev = {};
  const byRule = {};
  for (const f of findings) {
    bySev[f.severity] = (bySev[f.severity] || 0) + 1;
    byRule[f.ruleId] = (byRule[f.ruleId] || 0) + 1;
  }
  return { total: findings.length, bySeverity: bySev, byRule };
}
