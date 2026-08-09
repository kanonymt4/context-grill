import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIncluded } from '../util/misc.js';
import { log } from '../util/log.js';
import { redactMessage } from '../util/redact.js';
import { isSensitiveDir, isInside } from '../util/sensitive.js';
import { assertAllowed, auditExternal } from '../util/egress.js';
import { classify, isProbablyBinary, makeDoc, httpJson, isIndexable } from './base.js';

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
const READ_ONLY_GIT = new Set(['rev-parse', 'config', 'log', 'show', 'ls-files', 'ls-tree', 'status', '--version']);
const MANAGED_GIT = new Set(['clone', 'fetch', 'reset', 'remote', ...READ_ONLY_GIT]);
const FORBIDDEN_GIT = new Set(['push', 'commit', 'add', 'rm', 'mv', 'checkout', 'switch', 'clean', 'merge', 'rebase', 'cherry-pick', 'tag', 'am', 'apply', 'stash', 'filter-branch', 'gc', 'prune', 'worktree', 'submodule', 'send-email', 'daemon']);

const MANAGED_MARKER = '.context-grill-managed';
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;

function token(src) {
  const envName = src.auth?.tokenEnv || 'GITHUB_TOKEN';
  return process.env[envName] || null;
}

/** トークンを argv / URL / .git/config に一切載せず、環境変数経由でのみ git に渡す */
export function gitEnv(src) {
  const env = {
    ...process.env,
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

  if (!fs.existsSync(path.join(dir, '.git'))) {
    log.step(`clone ${src.repo} (${ref}) — 認証はヘッダ経由、URL には含めません`);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const args = ['clone', '--filter=blob:none', '--depth', String(src.depth || 1), '--no-tags', '--single-branch'];
    if (src.ref) args.push('--branch', src.ref);
    args.push('--', url, dir);
    await git(args, undefined, { src, allowWrite: true });
    await fsp.writeFile(path.join(dir, MANAGED_MARKER), `created by context-grill at ${new Date().toISOString()}\n`);
  } else {
    log.step(`fetch ${src.repo} (${ref})`);
    await git(['fetch', '--depth', String(src.depth || 1), '--no-tags', url, ref], dir, { src, allowWrite: true });
    await git(['reset', '--hard', 'FETCH_HEAD'], dir, { src, allowWrite: true });
  }
  const sha = await git(['rev-parse', 'HEAD'], dir, { src, allowWrite: false });
  auditExternal({ purpose: `git:${src.id}`, host, detail: `${src.repo}@${sha}` });
  return { dir, sha, managed: true };
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
      if (st.size > maxBytes) continue;
      const buf = await fsp.readFile(abs);
      if (isProbablyBinary(buf)) continue;
      const { kind, lang } = classify(rel);
      if (kind === 'other' && !src.includeUnknownTypes) continue;
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
      if (t.type !== 'blob' || t.size > maxBytes) return false;
      if (!isIndexable(t.path, security)) { blocked++; return false; }
      return isIncluded(t.path, include, exclude);
    });
    const limited = src.maxFiles ? files.slice(0, src.maxFiles) : files;
    for (const f of limited) {
      const { kind, lang } = classify(f.path);
      if (kind === 'other' && !src.includeUnknownTypes) continue;
      const blob = await httpJson(`${api}/repos/${src.repo}/git/blobs/${f.sha}`, { headers, purpose: `github:${src.id}` });
      const buf = Buffer.from(blob.content || '', blob.encoding === 'base64' ? 'base64' : 'utf8');
      if (isProbablyBinary(buf)) continue;
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
    const limit = Math.max(src.issues?.limit || 0, src.pulls?.limit || 0) || 100;
    const state = src.issues?.state || src.pulls?.state || 'all';
    let page = 1;
    const collected = [];
    while (collected.length < limit) {
      const items = await httpJson(`${api}/repos/${src.repo}/issues?state=${state}&per_page=100&page=${page}&sort=updated`, { headers, purpose: `github:${src.id}` });
      if (!items || items.length === 0) break;
      collected.push(...items);
      if (items.length < 100) break;
      page++;
    }
    for (const it of collected.slice(0, limit)) {
      const isPr = Boolean(it.pull_request);
      if (isPr && !src.pulls?.enabled) continue;
      if (!isPr && !src.issues?.enabled) continue;
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

  return { docs, state: { sha, syncedAt: new Date().toISOString(), count: docs.length, mode, blockedSensitive: blocked } };
}

export function githubLineUrl(doc, start, end) {
  if (!doc.meta?.repo || !doc.meta?.sha) return doc.url;
  const host = doc.meta.host || 'github.com';
  const base = `https://${host}/${doc.meta.repo}/blob/${doc.meta.sha}/${doc.path}`;
  return end && end !== start ? `${base}#L${start}-L${end}` : `${base}#L${start}`;
}
