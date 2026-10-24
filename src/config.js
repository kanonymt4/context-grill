import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { deepMerge, sha256, stableStringify } from './util/misc.js';
import { parseConfluenceUrl } from './util/urls.js';

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
  presets: [],                   // 名前付きの調査テンプレート（形式は src/presets.js。effortPresets とは別物）
  effortPresets: {
    low:    { queries: 3, final: 14, evidenceTokens: 20000 },
    normal: { queries: 6, final: 28, evidenceTokens: 55000 },
    deep:   { queries: 12, final: 56, evidenceTokens: 110000 },
  },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 真偽値として使われるキー。"false" のような文字列を通すと真偽判定が逆になる
const SECURITY_BOOL_FIELDS = ['allowEmbeddingUpload', 'allowLlmUpload', 'redactSecrets', 'denySensitivePaths', 'auditLog'];
const POLICY_BOOL_FIELDS = ['requireCitations', 'requireVerbatimQuote', 'forbidSpeculativeLanguage', 'dropUnverifiedItems'];
// 文字列の配列として使われる security のキー
const SECURITY_ARRAY_FIELDS = ['allowHosts', 'extraDenyPaths'];

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
    const rest = line.slice(eq + 1);
    let v = rest.trim();
    const q = v[0];
    const close = (q === '"' || q === "'") ? v.indexOf(q, 1) : -1;
    if (close > 0 && /^\s*(#.*)?$/.test(v.slice(close + 1))) {
      // 引用符で囲まれた値。閉じ引用符の後ろの行末コメントは捨て、中の # は保持する
      v = v.slice(1, close);
    } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      // 引用符なしの値は、空白の直後の # 以降を行末コメントとして捨てる（dotenv 互換）。abc#def は保持する
      v = rest.replace(/\s+#.*$/, '').trim();
    }
    if (!Object.hasOwn(process.env, k)) process.env[k] = v;
  }
}

/**
 * 文字列中の ${ENV_NAME} を展開する。
 * - 未定義の変数は黙って '' にせず、errs に「<JSON のパス> の ${NAME} は環境変数が未定義です」を積む
 *   （パスは sources[0].path のように示す。値は出さない）。定義済みで空文字の変数は '' に展開する。
 * - 定義の有無は Object.hasOwn で判定する（process.env[n] だと constructor などの prototype のキーを引く）。
 * - `_` で始まるキー（_comment / _README など）の配下は展開せず、文字のまま通す。
 */
function expandEnv(value, at = '', errs = []) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n) => {
      if (Object.hasOwn(process.env, n)) return process.env[n];
      errs.push(`${at} の \${${n}} は環境変数が未定義です`);
      return m;
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => expandEnv(v, `${at}[${i}]`, errs));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k.startsWith('_') ? v : expandEnv(v, at ? `${at}.${k}` : k, errs);
    }
    return out;
  }
  return value;
}

/**
 * JSON.parse した直後の木から、自分のキーとしての "__proto__" を探してパスを返す。
 * JSON.parse は "__proto__" を own のプロパティとして作るが、後段の `out[k] = v` は
 * プロトタイプの設定になり、Object.entries / Object.keys から見えなくなる。
 * 黙って消えるうえ、配列要素の中では秘密値スキャンも迂回できてしまうため、読み込みの
 * 入口で拒否する。最上位の presets の配下は validatePresets の担当なので走査しない。
 */
function findProtoKeys(node, at = '', found = []) {
  if (Array.isArray(node)) {
    node.forEach((n, i) => findProtoKeys(n, `${at}[${i}]`, found));
  } else if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const here = at ? `${at}.${k}` : k;
      if (k === '__proto__') found.push(here);
      if (at === '' && k === 'presets') continue;
      findProtoKeys(node[k], here, found);
    }
  }
  return found;
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
  const protoKeys = findProtoKeys(raw);
  if (protoKeys.length) {
    throw new Error('設定エラー:\n  - ' + protoKeys.map((p) => `${p} は使えません（"__proto__" キーは読み込み時に消えてしまうため）`).join('\n  - '));
  }
  // presets は環境変数展開の対象から外す。instruction 内の ${...} は文字のまま通す
  // （展開すると未定義の変数が黙って '' になり、指示文が欠ける）。
  // 実際の秘密値が貼られた場合は validate() の秘密値スキャンで拒否する。
  const rawIsObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
  const rawPresets = rawIsObject && Object.hasOwn(raw, 'presets') ? raw.presets : undefined;
  let rest = raw;
  if (rawIsObject) {
    const { presets: _omit, ...others } = raw;
    rest = others;
  }
  const envErrs = [];
  const expanded = expandEnv(rest, '', envErrs);
  if (envErrs.length) throw new Error('設定エラー:\n  - ' + envErrs.join('\n  - '));
  const merged = deepMerge(DEFAULTS, expanded);
  // DEFAULTS の配列を共有しない。形の検証は presets.js の validatePresets が行い、
  // ここでは throw しない（不正な preset があっても sync / search / MCP 起動は止めない）。
  merged.presets = rawPresets ?? [];
  merged.rootDir = rootDir;
  merged.configPath = configPath;
  merged.workspaceDir = path.resolve(rootDir, merged.workspace);
  // 配列を期待するフィールドに文字列が1つだけ書かれても動くようにする。
  // （文字列のまま for...of すると1文字ずつ反復してしまうため、ここで吸収する）
  const ARRAY_FIELDS = ['pageUrls', 'pageIds', 'labels', 'include', 'exclude', 'titleGlobs', 'spaceKeys'];
  for (const s of merged.sources || []) {
    for (const f of ARRAY_FIELDS) {
      if (typeof s[f] === 'string') s[f] = [s[f]];
    }
  }
  // sources 以外で配列として使われるキーも、文字列 1 つなら配列に直す
  // （直さないと for...of が 1 文字ずつ反復し、許可ホストや除外パターンが壊れる）
  if (isObj(merged.security)) {
    for (const f of SECURITY_ARRAY_FIELDS) {
      if (typeof merged.security[f] === 'string') merged.security[f] = [merged.security[f]];
    }
  }

  validate(merged);
  // 索引の再現性キー: ソース定義とチャンク設定のみが影響する
  merged.indexKey = sha256(stableStringify({
    sources: merged.sources,
    chunk: merged.retrieval.chunk,
    embedding: { p: merged.retrieval.embedding.provider, m: merged.retrieval.embedding.model, d: merged.retrieval.embedding.dimensions },
  }));
  // presets は調査の入口を名前で束ねただけで、索引にも設定の同一性にも影響させない
  merged.configHash = sha256(stableStringify({ ...merged, rootDir: undefined, configPath: undefined, workspaceDir: undefined, presets: undefined }));
  return merged;
}

function validate(c) {
  const errs = [];
  if (!Array.isArray(c.sources)) errs.push('sources は配列である必要があります');
  const ids = new Set();
  for (const [i, s] of (c.sources || []).entries()) {
    const where = `sources[${i}]`;
    if (!s.id) errs.push(`${where}.id が必要です`);
    else if (typeof s.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(s.id) || s.id === '.' || s.id === '..') {
      // id はキャッシュのディレクトリ名に使われる。../ を含むとワークスペースの外に書かれる
      errs.push(`${where}.id は英数字と . _ - だけで指定してください（. と .. 単体は不可）`);
    }
    if (ids.has(s.id)) errs.push(`${where}.id "${s.id}" が重複しています`);
    ids.add(s.id);
    if (!['github', 'confluence', 'jira', 'local'].includes(s.type)) {
      errs.push(`${where}.type は github|confluence|jira|local のいずれかです (現在: ${s.type})`);
    }
    if (s.type === 'github' && !s.repo && !s.path) errs.push(`${where}.repo (org/name) が必要です`);
    if (s.type === 'confluence' && !s.baseUrl) errs.push(`${where}.baseUrl が必要です`);
    if (s.type === 'jira' && !s.baseUrl) errs.push(`${where}.baseUrl が必要です`);
    // baseUrl は API のルート。ブラウザのページ URL をそのまま貼ると /api/v2/... を
    // 連結した先が 404 になるため、実際に叩く前にここで弾く。
    if ((s.type === 'confluence' || s.type === 'jira') && s.baseUrl) {
      const bad = String(s.baseUrl).match(/\/(spaces|pages|display|browse|wiki\/spaces)\//);
      // Jira の API はサイトのルート直下にあり、/wiki は Confluence 側のパス
      const jiraWiki = s.type === 'jira' && String(s.baseUrl).match(/^(https?:\/\/[^/?#]+)\/wiki(?:[/?#]|$)/i);
      if (bad) {
        const m = String(s.baseUrl).match(s.type === 'jira' ? /^(https?:\/\/[^/]+)/ : /^(https?:\/\/[^/]+(?:\/wiki)?)/);
        const suggest = m ? m[1] : 'https://your-org.atlassian.net' + (s.type === 'confluence' ? '/wiki' : '');
        const field = s.type === 'confluence' ? 'pageUrls / spaceKey' : 'jql / projectKey';
        errs.push(
          `${where}.baseUrl にページのパスが含まれています（"${bad[1]}/" 以降は不要です）\n` +
          `      指定された値: ${s.baseUrl}\n` +
          `      正しい形式  : ${suggest}\n` +
          `      特定のページ・課題を対象にする場合は ${field} で指定してください`
        );
      } else if (jiraWiki) {
        errs.push(
          `${where}.baseUrl に /wiki が含まれています（Jira の API はサイトのルート直下にあり、/wiki は Confluence 用です）\n` +
          `      指定された値: ${s.baseUrl}\n` +
          `      正しい形式  : ${jiraWiki[1]}\n` +
          `      Confluence と同じサイトでも、Jira の baseUrl には /wiki を付けないでください`
        );
      }
    }
    if (s.type === 'local' && !s.path) errs.push(`${where}.path が必要です`);

    // repo / ref の形式（sync まで待たずにここで弾く）
    if (s.type === 'github' && s.repo && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(s.repo))) {
      const m = String(s.repo).match(/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/);
      errs.push(
        `${where}.repo は "org/name" 形式で指定してください（現在: ${s.repo}）` +
        (m ? `\n      URL ではなく "${m[1]}" と書いてください` : '')
      );
    }
    // host は "ホスト名" か "ホスト名:ポート" だけ。userinfo・パス・スキームを許すと、表示・許可リストと
    // 実際の接続先が食い違う（github.com@127.0.0.1:1 は 127.0.0.1 へ接続する）。値は出さない
    if (s.type === 'github' && s.host != null && s.host !== '' && !/^[A-Za-z0-9.-]+(:\d+)?$/.test(String(s.host))) {
      errs.push(`${where}.host の形式が不正です（"ホスト名" または "ホスト名:ポート" のみ。スキーム・ユーザー情報・パスは書けません）`);
    }
    if (s.type === 'github' && s.ref && !/^[A-Za-z0-9._\/-]{1,200}$/.test(String(s.ref))) {
      errs.push(`${where}.ref の形式が不正です: ${s.ref}`);
    }

    // 配列を期待するフィールドの型（文字列は上で配列化済みなので、ここに来るのは別の型）
    for (const f of ['pageUrls', 'pageIds', 'labels', 'include', 'exclude']) {
      if (s[f] !== undefined && !Array.isArray(s[f])) {
        errs.push(`${where}.${f} は配列で指定してください（現在: ${typeof s[f]}）\n      例: "${f}": ["..."]`);
      }
    }

    // Confluence の pageUrls が解釈できる形か
    if (s.type === 'confluence' && Array.isArray(s.pageUrls)) {
      for (const [j, u] of s.pageUrls.entries()) {
        const parsed = parseConfluenceUrl(u);
        if (parsed?.pageId) continue;
        if (parsed?.kind === 'shortlink') {
          errs.push(
            `${where}.pageUrls[${j}] は短縮リンクのため解決できません: ${u}\n` +
            `      ページを開いて /wiki/spaces/.../pages/<数字>/... 形式の URL をコピーしてください`
          );
        } else {
          errs.push(`${where}.pageUrls[${j}] を Confluence のページ URL として解釈できません: ${u}`);
        }
      }
    }
  }
  if (!['anthropic', 'openai', 'openai-compat', 'dry'].includes(c.llm.provider)) {
    errs.push(`llm.provider は anthropic|openai|openai-compat|dry のいずれかです`);
  }
  if (!['normal', 'offline'].includes(c.security.networkMode)) {
    errs.push('security.networkMode は normal|offline のいずれかです');
  }
  // 真偽値のキー: 文字列 "false" が有効のまま残る（送信の同意が開く）のを防ぐ。null / 未定義は既定値
  for (const [sec, fields] of [['security', SECURITY_BOOL_FIELDS], ['policy', POLICY_BOOL_FIELDS]]) {
    if (!isObj(c[sec])) continue;
    for (const f of fields) {
      const v = c[sec][f];
      if (v !== undefined && v !== null && typeof v !== 'boolean') {
        errs.push(`${sec}.${f} は true / false で指定してください（文字列 "false" は使えません）`);
      }
    }
  }
  if (isObj(c.security)) {
    for (const f of SECURITY_ARRAY_FIELDS) {
      const v = c.security[f];
      if (v === undefined || v === null) continue;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        errs.push(`security.${f} は文字列、または文字列の配列で指定してください`);
      }
    }
  }
  // effortPresets: マージ後の値で検査する（既定の段階の部分指定は既定の値が残る）
  if (!isObj(c.effortPresets)) {
    errs.push('effortPresets はオブジェクトで指定してください');
  } else {
    const posInt = (v) => Number.isInteger(v) && v > 0;
    for (const [name, p] of Object.entries(c.effortPresets)) {
      if (!isObj(p)) { errs.push(`effortPresets.${name} はオブジェクトで指定してください`); continue; }
      for (const f of ['queries', 'final']) {
        if (!posInt(p[f])) errs.push(`effortPresets.${name}.${f} は正の整数で指定してください`);
      }
      if (p.evidenceTokens !== undefined && !posInt(p.evidenceTokens)) {
        errs.push(`effortPresets.${name}.evidenceTokens は正の整数で指定してください`);
      }
    }
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
  scan(c.presets, 'presets');
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
