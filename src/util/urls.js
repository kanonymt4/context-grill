/**
 * ブラウザからコピーした URL を、設定に書ける形へ分解する。
 * ネットワークアクセスは行わない（純粋なパース）。
 */

/**
 * @param {object} opts.anyHost true なら GitHub Enterprise Server など任意ホストも許可する
 *   （呼び出し側で Confluence / Jira 判定を先に済ませてから使うこと）
 */
export function parseGithubUrl(input, { anyHost = false } = {}) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  const isGithubCom = /(^|\.)github\.com$/i.test(u.host) || /github/i.test(u.host);
  if (!isGithubCom && !anyHost) return null;
  if (!isGithubCom && /atlassian\.net$/i.test(u.host)) return null;
  const seg = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (seg.length < 2) return null;
  const [org, repoRaw, kind, ...rest] = seg;
  const repo = repoRaw.replace(/\.git$/, '');
  const out = { host: u.host, repo: `${org}/${repo}`, ref: null, subPath: null, kind: 'repo' };

  if (kind === 'tree' || kind === 'blob') {
    // /org/repo/tree/<ref>/<path...> — ref にスラッシュを含むブランチ名は判別不能なので先頭 1 要素とする
    out.ref = rest[0] ? decodeURIComponent(rest[0]) : null;
    const sub = rest.slice(1).map(decodeURIComponent).join('/');
    out.subPath = sub || null;
    out.kind = kind === 'blob' ? 'file' : 'tree';
  } else if (kind === 'pull' || kind === 'issues') {
    out.kind = kind === 'pull' ? 'pull' : 'issue';
    out.number = Number(rest[0]) || null;
  }
  return out;
}

const CONF_PAGE_PATTERNS = [
  /\/wiki\/spaces\/([^/]+)\/pages\/(\d+)/i,          // /wiki/spaces/ENG/pages/12345/Title
  /\/spaces\/([^/]+)\/pages\/(\d+)/i,
  /\/display\/([^/]+)\/[^/]*\?.*pageId=(\d+)/i,
];

export function parseConfluenceUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  const full = u.pathname + u.search;

  // Cloud のベース URL は /wiki まで
  const wikiIdx = u.pathname.toLowerCase().indexOf('/wiki/');
  const baseUrl = wikiIdx >= 0 ? `${u.origin}${u.pathname.slice(0, wikiIdx + 5)}` : `${u.origin}/wiki`;

  const pageIdParam = u.searchParams.get('pageId');
  if (pageIdParam && /^\d+$/.test(pageIdParam)) {
    const sp = full.match(/\/(?:display|spaces)\/([^/?]+)/i);
    return { kind: 'page', baseUrl, spaceKey: sp ? decodeURIComponent(sp[1]) : null, pageId: pageIdParam, title: null };
  }
  for (const re of CONF_PAGE_PATTERNS) {
    const m = full.match(re);
    if (m) {
      const after = full.slice(m.index + m[0].length).replace(/^\//, '');
      const title = after ? decodeURIComponent(after.split(/[?#]/)[0].replace(/\+/g, ' ')) : null;
      return { kind: 'page', baseUrl, spaceKey: decodeURIComponent(m[1]), pageId: m[2], title };
    }
  }
  const sp = full.match(/\/(?:spaces|display)\/([^/?#]+)/i);
  if (sp) return { kind: 'space', baseUrl, spaceKey: decodeURIComponent(sp[1]), pageId: null, title: null };
  if (/\/wiki\/x\//i.test(u.pathname)) {
    return { kind: 'shortlink', baseUrl, spaceKey: null, pageId: null, title: null };
  }
  return null;
}

export function parseJiraUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  const m = u.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*)-(\d+)/i);
  if (m) return { kind: 'issue', baseUrl: u.origin, projectKey: m[1].toUpperCase(), key: `${m[1].toUpperCase()}-${m[2]}` };
  const p = u.searchParams.get('jql');
  if (p) return { kind: 'jql', baseUrl: u.origin, jql: p };
  const proj = u.pathname.match(/\/(?:projects|jira\/software\/(?:c\/)?projects)\/([A-Z][A-Z0-9_]*)/i);
  if (proj) return { kind: 'project', baseUrl: u.origin, projectKey: proj[1].toUpperCase() };
  return null;
}

/** URL から sources[] のエントリ案を作る */
export function urlToSource(input, { id } = {}) {
  // Atlassian 系を先に判定してから、残りを git ホストとして扱う
  const cfFirst = parseConfluenceUrl(input);
  const jrFirst = parseJiraUrl(input);
  const gh = (cfFirst || jrFirst) ? null : parseGithubUrl(input, { anyHost: true });
  if (gh) {
    const src = {
      id: id || gh.repo.split('/')[1].replace(/[^\w-]/g, '-'),
      type: 'github', repo: gh.repo, ref: gh.ref || 'main', mode: 'clone',
      include: gh.subPath
        ? (gh.kind === 'file' ? [gh.subPath] : [`${gh.subPath}/**`])
        : ['src/**', 'lib/**', 'app/**', 'docs/**', '*.md', 'package.json'],
      auth: { tokenEnv: 'GITHUB_TOKEN' },
    };
    if (gh.host !== 'github.com') { src.host = gh.host; src.apiBaseUrl = `https://${gh.host}/api/v3`; }
    const notes = [];
    if (!gh.ref) notes.push('ref は既定で "main" にしています。実際の既定ブランチに合わせてください。');
    if (gh.kind === 'pull' || gh.kind === 'issue') notes.push(`PR/Issue の URL です。本文を取り込むには ${gh.kind === 'pull' ? 'pulls' : 'issues'}.enabled を true にしてください。`);
    if (gh.subPath) notes.push(`URL のパス "${gh.subPath}" だけを include に設定しました。リポジトリ全体が必要なら include を広げてください。`);
    if (gh.host !== 'github.com') notes.push(`github.com 以外のホストです。GitHub Enterprise Server と仮定し apiBaseUrl を https://${gh.host}/api/v3 にしました（違う場合は修正してください）。`);
    return { source: src, notes, parsed: gh };
  }

  const cf = cfFirst;
  if (cf) {
    if (cf.kind === 'shortlink') {
      return { source: null, notes: ['短縮リンク (/wiki/x/...) は URL だけでは解決できません。ページを開いて通常の URL（/wiki/spaces/.../pages/数字/...）をコピーしてください。'], parsed: cf };
    }
    const base = { id: id || (cf.spaceKey ? `wiki-${cf.spaceKey.toLowerCase()}` : 'wiki'), type: 'confluence', baseUrl: cf.baseUrl, auth: { emailEnv: 'ATLASSIAN_EMAIL', tokenEnv: 'ATLASSIAN_API_TOKEN' } };
    if (cf.kind === 'page') {
      return {
        source: { ...base, pageIds: [cf.pageId], includeDescendants: true, limit: 200 },
        notes: [
          `ページ ${cf.pageId}${cf.title ? `（${cf.title}）` : ''} とその配下ページを取り込む設定です。`,
          '配下が不要なら includeDescendants を false にしてください。',
        ],
        parsed: cf,
      };
    }
    return {
      source: { ...base, spaceKey: cf.spaceKey, limit: 500 },
      notes: [`スペース ${cf.spaceKey} 全体を取り込む設定です。多すぎる場合は pageIds や labels、exclude で絞ってください。`],
      parsed: cf,
    };
  }

  const jr = jrFirst;
  if (jr) {
    const base = { id: id || (jr.projectKey ? `jira-${jr.projectKey.toLowerCase()}` : 'jira'), type: 'jira', baseUrl: jr.baseUrl, auth: { emailEnv: 'ATLASSIAN_EMAIL', tokenEnv: 'ATLASSIAN_API_TOKEN' } };
    if (jr.kind === 'issue') return { source: { ...base, jql: `key = ${jr.key}`, limit: 1 }, notes: [`単一チケット ${jr.key} の設定です。プロジェクト全体なら jql を "project = ${jr.projectKey} ORDER BY updated DESC" にしてください。`], parsed: jr };
    if (jr.kind === 'jql') return { source: { ...base, jql: jr.jql, limit: 200 }, notes: ['URL の JQL をそのまま使用します。'], parsed: jr };
    return { source: { ...base, jql: `project = ${jr.projectKey} AND updated >= -180d ORDER BY updated DESC`, limit: 300 }, notes: ['直近 180 日に更新されたチケットに絞っています。'], parsed: jr };
  }

  return { source: null, notes: ['GitHub / Confluence / Jira の URL として解釈できませんでした。'], parsed: null };
}
