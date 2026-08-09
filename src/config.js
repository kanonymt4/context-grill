import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { deepMerge, sha256, stableStringify } from './util/misc.js';

export const DEFAULTS = {
  project: 'untitled',
  workspace: '.context-grill',
  language: 'ja',
  sources: [],
  retrieval: {
    chunk: {
      code: { maxLines: 110, overlapLines: 12, maxChars: 6000 },
      doc: { maxChars: 2200, overlapChars: 220 },
    },
    glossaryBridge: true,
    hybrid: { bm25Top: 150, vectorTop: 150, rrfK: 60, mmrLambda: 0.72, final: 28, perQueryTop: 60 },
    boosts: { pathMatch: 0.35, titleMatch: 0.25, sourcePriority: 0.15, kindPrior: 0.2 },
    embedding: {
      provider: 'none',          // none | openai | voyage | openai-compat
      model: 'text-embedding-3-small',
      dimensions: 512,
      baseUrl: null,
      apiKeyEnv: 'OPENAI_API_KEY',
      batch: 96,
    },
  },
  llm: {
    provider: 'anthropic',       // anthropic | openai | openai-compat | dry
    model: 'claude-sonnet-5',
    plannerModel: null,          // 省略時は決定的プランナのみを使用
    baseUrl: null,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    temperature: 0,
    topP: null,
    maxOutputTokens: 8000,
    promptCache: true,
    timeoutMs: 180000,
  },
  budget: {
    evidenceTokens: 55000,
    staticFactsTokens: 6000,
    maxTotalTokensPerRun: 220000,
    maxRepairs: 2,
  },
  security: {
    networkMode: 'normal',        // normal | offline （offline は一切の外部通信を拒否）
    allowHosts: [],               // 追加で許可する送信先ホスト
    denySensitivePaths: true,     // .env / 秘密鍵 / .netrc 等を無条件に索引除外
    extraDenyPaths: [],
    redactSecrets: true,          // 証拠・静的解析結果からシークレットを墨消し
    allowEmbeddingUpload: false,  // 埋め込み API へ本文を送ることを明示的に許可する場合のみ true
    allowLlmUpload: true,         // false にすると ask / run_task をブロック（検索・静的解析のみ利用）
    auditLog: true,
    workspaceMode: 0o700,
  },
  policy: {
    requireCitations: true,
    minEvidencePerItem: 1,
    requireVerbatimQuote: true,
    dropUnverifiedItems: true,
    forbidSpeculativeLanguage: true,
    language: 'ja',
  },
  effortPresets: {
    low:    { queries: 3, final: 14, evidenceTokens: 20000 },
    normal: { queries: 6, final: 28, evidenceTokens: 55000 },
    deep:   { queries: 12, final: 56, evidenceTokens: 110000 },
  },
};

const CONFIG_NAMES = ['context-grill.config.json', '.context-grill.config.json', 'context-grill.json'];

export function findConfigPath(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 依存ゼロの .env ローダ（既存の process.env を上書きしない） */
export function loadDotEnv(dir) {
  const p = path.join(dir, '.env');
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/** 文字列中の ${ENV_NAME} を展開 */
function expandEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] ?? '');
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnv(v);
    return out;
  }
  return value;
}

export async function loadConfig(explicitPath) {
  const configPath = explicitPath ? path.resolve(explicitPath) : findConfigPath();
  if (!configPath) {
    const e = new Error('context-grill.config.json が見つかりません。`context-grill init` で作成してください。');
    e.code = 'ENOCONFIG';
    throw e;
  }
  const rootDir = path.dirname(configPath);
  loadDotEnv(rootDir);
  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`設定ファイルの JSON が不正です (${configPath}): ${e.message}`);
  }
  const merged = deepMerge(DEFAULTS, expandEnv(raw));
  merged.rootDir = rootDir;
  merged.configPath = configPath;
  merged.workspaceDir = path.resolve(rootDir, merged.workspace);
  validate(merged);
  // 索引の再現性キー: ソース定義とチャンク設定のみが影響する
  merged.indexKey = sha256(stableStringify({
    sources: merged.sources,
    chunk: merged.retrieval.chunk,
    embedding: { p: merged.retrieval.embedding.provider, m: merged.retrieval.embedding.model, d: merged.retrieval.embedding.dimensions },
  }));
  merged.configHash = sha256(stableStringify({ ...merged, rootDir: undefined, configPath: undefined, workspaceDir: undefined }));
  return merged;
}

function validate(c) {
  const errs = [];
  if (!Array.isArray(c.sources)) errs.push('sources は配列である必要があります');
  const ids = new Set();
  for (const [i, s] of (c.sources || []).entries()) {
    const where = `sources[${i}]`;
    if (!s.id) errs.push(`${where}.id が必要です`);
    if (ids.has(s.id)) errs.push(`${where}.id "${s.id}" が重複しています`);
    ids.add(s.id);
    if (!['github', 'confluence', 'jira', 'local'].includes(s.type)) {
      errs.push(`${where}.type は github|confluence|jira|local のいずれかです (現在: ${s.type})`);
    }
    if (s.type === 'github' && !s.repo && !s.path) errs.push(`${where}.repo (org/name) が必要です`);
    if (s.type === 'confluence' && !s.baseUrl) errs.push(`${where}.baseUrl が必要です`);
    if (s.type === 'jira' && !s.baseUrl) errs.push(`${where}.baseUrl が必要です`);
    if (s.type === 'local' && !s.path) errs.push(`${where}.path が必要です`);
  }
  if (!['anthropic', 'openai', 'openai-compat', 'dry'].includes(c.llm.provider)) {
    errs.push(`llm.provider は anthropic|openai|openai-compat|dry のいずれかです`);
  }
  if (!['normal', 'offline'].includes(c.security.networkMode)) {
    errs.push('security.networkMode は normal|offline のいずれかです');
  }
  // 展開後の設定値に秘密の実値が紛れ込んでいないか（URL 等への混入で外部に漏れるのを防ぐ）
  const secretValues = Object.entries(process.env)
    .filter(([k, v]) => v && v.length >= 12 && /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(k))
    .map(([k, v]) => [k, v]);
  const scan = (node, at) => {
    if (typeof node === 'string') {
      for (const [k, v] of secretValues) {
        if (node.includes(v) && !/^\s*$/.test(node)) {
          errs.push(`${at} に環境変数 ${k} の値が展開されています。認証情報は auth.*Env で参照し、URL 等に直接埋め込まないでください`);
        }
      }
    } else if (Array.isArray(node)) node.forEach((n, i) => scan(n, `${at}[${i}]`));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) scan(v, `${at}.${k}`);
  };
  scan(c.sources, 'sources');
  scan(c.llm, 'llm');
  scan(c.retrieval, 'retrieval');
  scan(c.security, 'security');
  if (errs.length) throw new Error('設定エラー:\n  - ' + errs.join('\n  - '));
}

export function paths(config) {
  const w = config.workspaceDir;
  return {
    workspace: w,
    cache: path.join(w, 'cache'),
    repos: path.join(w, 'repos'),
    index: path.join(w, 'index'),
    runs: path.join(w, 'runs'),
    embed: path.join(w, 'cache', 'embed'),
    sourceCache: (id) => path.join(w, 'cache', 'sources', id),
  };
}

export async function ensureDirs(config) {
  const p = paths(config);
  const mode = config.security?.workspaceMode ?? 0o700;
  for (const d of [p.workspace, p.cache, p.repos, p.index, p.runs, p.embed]) {
    await fsp.mkdir(d, { recursive: true, mode });
  }
  // 既存ディレクトリにも権限を適用（社内ソースを平文で保持するため他ユーザーから隔離する）
  if (process.platform !== 'win32') {
    try { await fsp.chmod(p.workspace, mode); } catch { /* 権限変更できない FS では無視 */ }
  }
  const gi = path.join(p.workspace, '.gitignore');
  if (!fs.existsSync(gi)) await fsp.writeFile(gi, '*\n');
  return p;
}
