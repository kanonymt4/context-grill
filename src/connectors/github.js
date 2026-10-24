import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIncluded, readEnv } from '../util/misc.js';
import { log } from '../util/log.js';
import { redactMessage } from '../util/redact.js';
import { isSensitiveDir, isInside } from '../util/sensitive.js';
import { assertAllowed, auditExternal, EgressBlocked } from '../util/egress.js';
import { classify, isProbablyBinary, makeDoc, httpJson, isIndexable, emptySkipped } from './base.js';

const exec = promisify(execFile);

const DEFAULT_EXCLUDE = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**',
  '**/vendor/**', '**/target/**', '**/.next/**', '**/coverage/**', '**/__pycache__/**',
  '**/*.min.js', '**/*.min.css', '**/*.map', '**/*.lock', '**/*.png', '**/*.jpg',
  '**/*.jpeg', '**/*.gif', '**/*.svg', '**/*.ico', '**/*.pdf', '**/*.zip', '**/*.gz',
  '**/*.woff*', '**/*.ttf', '**/*.mp4', '**/*.snap',
];

// context-grill が実行してよい git サブコマンド。これ以外は実行しない。
// 特に push / commit / add / checkout / clean / rm は allowWrite でも実行できない。
const READ_ONLY_GIT = new Set(['rev-parse', 'ls-remote', 'config', 'log', 'show', 'ls-files', 'ls-tree', 'status', '--version']);
const MANAGED_GIT = new Set(['init', 'fetch', 'reset', 'remote', ...READ_ONLY_GIT]);
const FORBIDDEN_GIT = new Set(['push', 'commit', 'add', 'rm', 'mv', 'checkout', 'switch', 'clean', 'merge', 'rebase', 'cherry-pick', 'tag', 'am', 'apply', 'stash', 'filter-branch', 'gc', 'prune', 'worktree', 'submodule', 'send-email', 'daemon']);

const MANAGED_MARKER = '.context-grill-managed';
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// 先頭が - だと git のオプションとして解釈されるため許さない
const REF_RE = /^(?!-)[A-Za-z0-9._\/-]{1,200}$/;

// 継承させない環境変数。対象リポジトリの位置や設定を、利用者の環境（git フックの中など）から
// 差し込めてしまうため。GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM は社内 CA・proxy の設定を
// 運ぶことがあるので消さない
const INHERITED_GIT_ENV_DROP = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
]);

function token(src) {
  const envName = src.auth?.tokenEnv || 'GITHUB_TOKEN';
  return readEnv(envName) || null;
}

/** トークンを argv / URL / .git/config に一切載せず、環境変数経由でのみ git に渡す */
export function gitEnv(src) {
  const inherited = { ...process.env };
  for (const k of Object.keys(inherited)) {
    if (INHERITED_GIT_ENV_DROP.has(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete inherited[k];
  }
  const env = {
    ...inherited,
    GIT_TERMINAL_PROMPT: '0',        // 認証プロンプトでハングしない
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1',        // ホスト側の system 設定に影響されない
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  const tk = token(src);
  if (tk) {
    // git 2.31+ の GIT_CONFIG_* 経由。ps 出力・エラーメッセージ・.git/config のいずれにも残らない。
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = 'Authorization: Basic ' + Buffer.from(`x-access-token:${tk}`).toString('base64');
  }
  return env;
}

/**
 * git 実行の唯一の入口。
 *  - サブコマンドの許可リストを強制（破壊的コマンドは定義上到達不能）
 *  - allowWrite=false のとき、ユーザーのリポジトリに対しては参照系しか実行しない
 *  - エラーメッセージは必ず墨消ししてから投げ直す
 */
export function assertGitSubcommand(sub, allowWrite = false) {
  if (FORBIDDEN_GIT.has(sub)) throw new Error(`破壊的な git サブコマンドは実行できません (${sub})`);
  const allowed = allowWrite ? MANAGED_GIT : READ_ONLY_GIT;
  if (!allowed.has(sub)) throw new Error(`この文脈で許可されていない git サブコマンドです (${sub}, allowWrite=${allowWrite})`);
  return true;
}

async function git(args, cwd, { src = {}, allowWrite = false } = {}) {
  const sub = args[0];
  assertGitSubcommand(sub, allowWrite);
  try {
    const { stdout } = await exec('git', args, { cwd, env: gitEnv(src), maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = new Error(redactMessage(e.message, [token(src)].filter(Boolean)));
    err.stderr = redactMessage(e.stderr || '', [token(src)].filter(Boolean));
    throw err;
  }
}

/** 管理下のクローンであることを保証してから破壊的操作を許可する */
export async function assertManagedClone(dir, reposDir) {
  if (!isInside(reposDir, dir)) {
    throw new Error(`安全のため、ワークスペース外のディレクトリは操作しません: ${dir}`);
  }
  const marker = path.join(dir, MANAGED_MARKER);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0 && !fs.existsSync(marker)) {
    throw new Error(
      `${dir} は context-grill が作成したクローンではないため、上書き・reset を行いません。\n` +
      `別のディレクトリを workspace に指定するか、このディレクトリを削除してください。`
    );
  }
}

/**
 * git が実際に接続する先を、通信せずに求めて許可リストで検査する。
 * `git ls-remote --get-url` は insteadOf を展開した URL を返す。設定上のホストと
 * 展開後のホストが違えば、その宛先も assertAllowed を通す（許可外なら EgressBlocked）。
 * パースできない形（scp 風・ローカルパス・file:// など）はホストを特定できないので、
 * 展開後の文字列そのものを渡して許可リストに照合させる（= 許可されない）。
 */
async function assertEffectiveHostAllowed(src, url, host, cwd) {
  const effective = await git(['ls-remote', '--get-url', url], cwd, { src, allowWrite: false });
  if (!effective || effective === url) return;
  let effHost = null;
  if (effective.includes('://')) {
    try {
      const u = new URL(effective);
      // https 以外へ書き換えられると、同じホストでも http.extraHeader のトークンが平文で送られる
      if (u.protocol !== 'https:') {
        throw new EgressBlocked(
          `insteadOf により https 以外のスキームへ書き換えられています (git:${src.id} (insteadOf): ${u.protocol}//${u.host}). ` +
          `gitconfig の url.<base>.insteadOf を確認してください。`
        );
      }
      effHost = u.host.toLowerCase() || null;
    } catch (e) {
      if (e instanceof EgressBlocked) throw e;
      /* パースできない形は下で effective を使う */
    }
  } else {
    const m = /^(?:[^@/:]+@)?([^:/]+):/.exec(effective);   // scp 風: [user@]host:path
    if (m) effHost = m[1].toLowerCase();
  }
  if (effHost === host) return;
  assertAllowed({ host: effHost ?? effective, method: 'GET', purpose: `git:${src.id} (insteadOf)` });
}

/** clone/pull して作業ディレクトリのパスと HEAD sha を返す */
async function ensureClone(src, reposDir) {
  // (A) ユーザーのローカル作業リポジトリを参照するモード: 完全に読み取り専用
  if (src.path) {
    const p = path.resolve(src.path);
    if (!fs.existsSync(p)) throw new Error(`ローカルリポジトリが存在しません: ${p}`);
    let sha = 'worktree';
    try { sha = await git(['rev-parse', 'HEAD'], p, { src, allowWrite: false }); } catch { /* git 管理外でも可 */ }
    return { dir: p, sha, managed: false };
  }

  // (B) context-grill がワークスペース内に持つクローン
  if (!REPO_RE.test(String(src.repo || ''))) {
    throw new Error(`sources[${src.id}].repo の形式が不正です（"org/name" 形式のみ）: ${src.repo}`);
  }
  if (src.ref && !REF_RE.test(String(src.ref))) {
    throw new Error(`sources[${src.id}].ref の形式が不正です: ${src.ref}`);
  }
  const host = (src.host || 'github.com').toLowerCase();
  assertAllowed({ host, method: 'GET', purpose: `git:${src.id}` });

  const dir = path.join(reposDir, src.id.replace(/[^A-Za-z0-9._-]/g, '_'));
  await assertManagedClone(dir, reposDir);
  const url = `https://${host}/${src.repo}.git`;   // トークンを含めない
  const ref = src.ref || 'HEAD';
  const cloned = fs.existsSync(path.join(dir, '.git'));

  if (!cloned) {
    // 初回も既存クローンと同じ経路（init → fetch → reset）で取得する。先にクローンの入れ物を作るのは、
    // 次の insteadOf 検査を実際の取得と同じ cwd で行うため（includeIf "gitdir:" 内の設定は、
    // そのリポジトリの中でしか効かない）。この段階では通信しない
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await git(['init', '-q'], dir, { src, allowWrite: true });
    await fsp.writeFile(path.join(dir, MANAGED_MARKER), `created by context-grill at ${new Date().toISOString()}\n`);
  }

  // ユーザーの gitconfig（url.<base>.insteadOf）で接続先が書き換わっていないかを、通信する前に検査する
  await assertEffectiveHostAllowed(src, url, host, dir);

  try {
    log.step(`${cloned ? 'fetch' : 'clone'} ${src.repo} (${ref})${cloned ? '' : ' — 認証はヘッダ経由、URL には含めません'}`);
    await git(['fetch', '--depth', String(src.depth || 1), '--no-tags', '--', url, ref], dir, { src, allowWrite: true });
    await git(['reset', '--hard', 'FETCH_HEAD'], dir, { src, allowWrite: true });
    const sha = await git(['rev-parse', 'HEAD'], dir, { src, allowWrite: false });
    auditExternal({ purpose: `git:${src.id}`, host, detail: `${src.repo}@${sha}` });
    return { dir, sha, managed: true };
  } catch (e) {
    // 失敗も監査ログに残す（接続を試みた後に失敗した通信を「0 回」と見せない）。認証情報は残さない
    const last = String(e?.message || e).split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
    auditExternal({
      purpose: `git:${src.id}`,
      host: host.replace(/^.*@/, ''),   // host に userinfo が混ざっていても記録しない
      detail: `failed: ${redactMessage(last)}`,
    });
    throw e;
  }
}

async function* walk(root, rel = '') {
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    if (isSensitiveDir(e.name) || e.name === MANAGED_MARKER) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;   // リポジトリ外への参照を防ぐ
    if (e.isDirectory()) yield* walk(root, r);
    else if (e.isFile()) yield r;
  }
}

function permalink(src, sha, p, start, end) {
  if (!src.repo) return null;
  const host = src.host || 'github.com';
  const base = `https://${host}/${src.repo}/blob/${sha}/${p}`;
  if (start == null) return base;
  return end != null && end !== start ? `${base}#L${start}-L${end}` : `${base}#L${start}`;
}

export async function syncGithub(src, ctx) {
  const security = ctx?.config?.security || {};
  let blocked = 0;
  const skipped = emptySkipped();
  const include = src.include || [];
  const exclude = [...DEFAULT_EXCLUDE, ...(src.exclude || [])];
  const maxBytes = src.maxFileBytes ?? 400_000;
  const docs = [];
  const mode = src.mode || 'clone';
  let sha = 'unknown';

  if (mode === 'clone') {
    const { dir, sha: head } = await ensureClone(src, ctx.paths.repos);
    sha = head;
    let n = 0;
    for await (const rel of walk(dir)) {
      if (!isIndexable(rel, security)) { blocked++; continue; }
      if (!isIncluded(rel, include, exclude)) continue;
      const abs = path.join(dir, rel);
      const st = await fsp.stat(abs);
      if (st.size > maxBytes) { skipped.tooLarge++; continue; }
      const buf = await fsp.readFile(abs);
      if (isProbablyBinary(buf)) { skipped.binary++; continue; }
      const { kind, lang } = classify(rel);
      if (kind === 'other' && !src.includeUnknownTypes) { skipped.unknownType++; continue; }
      docs.push(makeDoc({
        sourceId: src.id, sourceType: 'github', docPath: rel, title: rel,
        kind, lang, text: buf.toString('utf8'),
        url: permalink(src, sha, rel), version: sha,
        meta: { repo: src.repo || path.basename(dir), sha, bytes: st.size },
      }));
      n++;
      if (src.maxFiles && n >= src.maxFiles) { log.warn(`maxFiles=${src.maxFiles} に達したため打ち切り`); break; }
    }
  } else {
    // API モード: サブセット取得向け（大規模リポには clone を推奨）
    const tk = token(src);
    const api = src.apiBaseUrl || 'https://api.github.com';
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'context-grill' };
    if (tk) headers.Authorization = `Bearer ${tk}`;
    const refInfo = await httpJson(`${api}/repos/${src.repo}/commits/${encodeURIComponent(src.ref || 'HEAD')}`, { headers, purpose: `github:${src.id}` });
    sha = refInfo.sha;
    const tree = await httpJson(`${api}/repos/${src.repo}/git/trees/${sha}?recursive=1`, { headers, purpose: `github:${src.id}` });
    const files = (tree.tree || []).filter((t) => {
      if (t.type !== 'blob') return false;
      if (!isIndexable(t.path, security)) { blocked++; return false; }
      if (!isIncluded(t.path, include, exclude)) return false;
      if (t.size > maxBytes) { skipped.tooLarge++; return false; }
      return true;
    });
    const limited = src.maxFiles ? files.slice(0, src.maxFiles) : files;
    for (const f of limited) {
      const { kind, lang } = classify(f.path);
      if (kind === 'other' && !src.includeUnknownTypes) { skipped.unknownType++; continue; }
      const blob = await httpJson(`${api}/repos/${src.repo}/git/blobs/${f.sha}`, { headers, purpose: `github:${src.id}` });
      const buf = Buffer.from(blob.content || '', blob.encoding === 'base64' ? 'base64' : 'utf8');
      if (isProbablyBinary(buf)) { skipped.binary++; continue; }
      docs.push(makeDoc({
        sourceId: src.id, sourceType: 'github', docPath: f.path, title: f.path,
        kind, lang, text: buf.toString('utf8'),
        url: permalink(src, sha, f.path), version: sha,
        meta: { repo: src.repo, sha, bytes: f.size },
      }));
    }
  }

  // Issue / PR も一次資料として取り込む（既定はオフ）
  if (src.issues?.enabled || src.pulls?.enabled) {
    const tk = token(src);
    const api = src.apiBaseUrl || 'https://api.github.com';
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'context-grill' };
    if (tk) headers.Authorization = `Bearer ${tk}`;
    // issues と pulls は別々に取得し、それぞれの limit / state を守る。
    // /issues は PR も返すので、issues 側では pull_request を持つものを数えずに除く。
    const fetchKind = async (endpoint, cfg, accept, isPr) => {
      const limit = cfg.limit || 100;
      const state = cfg.state || 'all';
      const collected = [];
      let page = 1;
      while (collected.length < limit) {
        const items = await httpJson(`${api}/repos/${src.repo}/${endpoint}?state=${state}&per_page=100&page=${page}&sort=updated`, { headers, purpose: `github:${src.id}` });
        if (!items || items.length === 0) break;
        collected.push(...items.filter(accept));
        if (items.length < 100) break;
        page++;
      }
      return collected.slice(0, limit).map((it) => ({ it, isPr }));
    };
    const collected = [];
    if (src.issues?.enabled) collected.push(...await fetchKind('issues', src.issues, (it) => !it.pull_request, false));
    if (src.pulls?.enabled) collected.push(...await fetchKind('pulls', src.pulls, () => true, true));
    for (const { it, isPr } of collected) {
      const body = [
        `# ${isPr ? 'PR' : 'Issue'} #${it.number}: ${it.title}`,
        `state: ${it.state} / author: ${it.user?.login} / created: ${it.created_at} / updated: ${it.updated_at}`,
        `labels: ${(it.labels || []).map((l) => l.name || l).join(', ') || '(none)'}`,
        '', it.body || '(本文なし)',
      ].join('\n');
      docs.push(makeDoc({
        sourceId: src.id, sourceType: 'github', docPath: `${isPr ? 'pulls' : 'issues'}/${it.number}`,
        title: `${isPr ? 'PR' : 'Issue'} #${it.number} ${it.title}`,
        kind: isPr ? 'pr' : 'issue', lang: 'md', text: body,
        url: it.html_url, version: it.updated_at,
        meta: { repo: src.repo, number: it.number, state: it.state },
      }));
    }
  }

  return { docs, state: { sha, syncedAt: new Date().toISOString(), count: docs.length, mode, blockedSensitive: blocked, skipped } };
}

export function githubLineUrl(doc, start, end) {
  if (!doc.meta?.repo || !doc.meta?.sha) return doc.url;
  const host = doc.meta.host || 'github.com';
  const base = `https://${host}/${doc.meta.repo}/blob/${doc.meta.sha}/${doc.path}`;
  return end && end !== start ? `${base}#L${start}-L${end}` : `${base}#L${start}`;
}
