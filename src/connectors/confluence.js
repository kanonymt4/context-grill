import { htmlToText } from '../util/html.js';
import { isIncluded } from '../util/misc.js';
import { parseConfluenceUrl } from '../util/urls.js';
import { log } from '../util/log.js';
import { makeDoc, httpJson, requireEnv } from './base.js';

function authHeader(src) {
  const bearerEnv = src.auth?.bearerEnv || 'ATLASSIAN_BEARER';
  if (process.env[bearerEnv]) return `Bearer ${process.env[bearerEnv]}`;
  const email = requireEnv(src.auth?.emailEnv || 'ATLASSIAN_EMAIL', 'Atlassian のログインメールを設定してください。');
  const tk = requireEnv(src.auth?.tokenEnv || 'ATLASSIAN_API_TOKEN',
    'https://id.atlassian.com/manage-profile/security/api-tokens で API トークンを発行してください。');
  return 'Basic ' + Buffer.from(`${email}:${tk}`).toString('base64');
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** v1 / v2 どちらの応答形でもドキュメントに正規化する */
function toDoc(src, base, p, cache) {
  const title = p.title || `(untitled ${p.id})`;
  const docPath = `pages/${p.id}`;
  const version = String(p.version?.number ?? p.version?.createdAt ?? p.version?.when ?? '');
  const cached = cache.get(`${src.id}:${docPath}`);
  let text;
  if (cached && cached.version === version && cached.text) {
    text = cached.text;                       // 版が同じなら再解析しない（差分同期）
  } else {
    const storage = p.body?.storage?.value || p.body?.view?.value || p.body?.atlas_doc_format?.value || '';
    text = `# ${title}\n\n` + htmlToText(storage);
  }
  const webui = p._links?.webui || `/spaces/${p.space?.key || src.spaceKey || ''}/pages/${p.id}`;
  return makeDoc({
    sourceId: src.id, sourceType: 'confluence', docPath, title,
    kind: 'doc', lang: 'md', text,
    url: base + (webui.startsWith('/') ? webui : `/${webui}`),
    version,
    meta: {
      pageId: String(p.id), spaceKey: p.space?.key || src.spaceKey || null,
      status: p.status, contentType: 'pages',
      updatedAt: p.version?.createdAt || p.version?.when || null,
      labels: (p.metadata?.labels?.results || []).map((l) => l.name),
    },
  });
}

/** 明示指定されたページ ID を集める（URL 直貼りにも対応） */
function collectSeedIds(src) {
  const ids = new Set((src.pageIds || []).map(String));
  for (const u of src.pageUrls || []) {
    const parsed = parseConfluenceUrl(u);
    if (parsed?.pageId) ids.add(String(parsed.pageId));
    else if (parsed?.kind === 'shortlink') {
      throw new Error(`短縮リンクは解決できません: ${u}\nページを開いて /wiki/spaces/.../pages/<数字>/... 形式の URL をコピーしてください。`);
    } else {
      throw new Error(`Confluence のページ URL として解釈できません: ${u}`);
    }
  }
  return [...ids];
}

/** 子ページを再帰的に辿る（ページツリー単位の取り込み） */
async function expandDescendants(base, headers, seeds, { maxDepth = 10, limit = 500, purpose }) {
  const all = new Set(seeds);
  let frontier = [...seeds];
  for (let depth = 0; depth < maxDepth && frontier.length && all.size < limit; depth++) {
    const next = [];
    for (const id of frontier) {
      let url = `${base}/api/v2/pages/${encodeURIComponent(id)}/children?limit=250`;
      while (url && all.size < limit) {
        const res = await httpJson(url, { headers, purpose });
        for (const c of res?.results || []) {
          const cid = String(c.id);
          if (!all.has(cid)) { all.add(cid); next.push(cid); }
          if (all.size >= limit) break;
        }
        const nx = res?._links?.next;
        url = nx ? (nx.startsWith('http') ? nx : base.replace(/\/wiki$/, '') + nx) : null;
      }
    }
    frontier = next;
    if (next.length) log.step(`Confluence 配下ページ 深さ${depth + 1}: +${next.length} 件`);
  }
  return [...all];
}

/** ID 指定でページ本文をまとめて取得（バッチ失敗時は 1 件ずつ取り直す） */
async function fetchPagesByIds(base, headers, ids, purpose) {
  const out = [];
  for (const group of chunk(ids, 50)) {
    const qs = group.map((i) => `id=${encodeURIComponent(i)}`).join('&');
    let got = [];
    try {
      const res = await httpJson(`${base}/api/v2/pages?${qs}&body-format=storage&limit=50`, { headers, purpose });
      got = res?.results || [];
    } catch (e) {
      log.warn(`一括取得に失敗したため個別取得に切り替えます: ${e.message.split('\n')[0]}`);
    }
    const found = new Set(got.map((p) => String(p.id)));
    out.push(...got);
    for (const id of group) {
      if (found.has(String(id))) continue;
      try {
        const p = await httpJson(`${base}/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`, { headers, purpose });
        if (p) out.push(p);
      } catch (e) {
        log.warn(`ページ ${id} を取得できません（権限またはIDを確認してください）: ${e.message.split('\n')[0]}`);
      }
    }
  }
  return out;
}

/** CQL 検索（ラベル絞り込み・任意の CQL）。v1 検索 API を使う。 */
async function fetchByCql(base, headers, cql, limit, purpose) {
  const out = [];
  let url = `${base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&expand=body.storage,version,space,metadata.labels&limit=50`;
  while (url && out.length < limit) {
    const res = await httpJson(url, { headers, purpose });
    const results = res?.results || [];
    out.push(...results);
    const nx = res?._links?.next;
    url = nx && results.length ? (nx.startsWith('http') ? nx : base.replace(/\/wiki$/, '') + nx) : null;
  }
  return out.slice(0, limit);
}

function buildCql(src) {
  if (src.cql) return src.cql;
  const parts = [];
  if (src.spaceKey) parts.push(`space = "${src.spaceKey}"`);
  if (src.labels?.length) parts.push(`label in (${src.labels.map((l) => `"${l}"`).join(', ')})`);
  if (src.titleContains) parts.push(`title ~ "${src.titleContains}"`);
  if (src.updatedWithinDays) parts.push(`lastmodified >= now("-${Number(src.updatedWithinDays)}d")`);
  if (!parts.length) return null;
  parts.push('type = page');
  return parts.join(' AND ') + ' ORDER BY lastmodified DESC';
}

/**
 * 取り込み範囲の決め方は 3 通り。上から優先される。
 *  A) pageUrls / pageIds  … ページを名指し（includeDescendants で配下も）
 *  B) cql / labels / titleContains / updatedWithinDays … 条件で絞り込み
 *  C) spaceKey / spaceId  … スペース全体
 * どのモードでも include / exclude（ページタイトルへの glob）で最終フィルタできる。
 */
export async function syncConfluence(src, ctx) {
  const base = String(src.baseUrl).replace(/\/+$/, '');
  const headers = { Authorization: authHeader(src), Accept: 'application/json' };
  const purpose = `confluence:${src.id}`;
  const limit = src.limit ?? 500;
  const pageSize = Math.min(src.pageSize ?? 100, 250);
  const cache = new Map((ctx?.previousDocs || []).map((d) => [d.docId, d]));

  const seeds = collectSeedIds(src);
  let raw = [];
  let mode;

  if (seeds.length) {
    // ---- A) ページ名指し ----
    mode = src.includeDescendants ? 'pages+descendants' : 'pages';
    const ids = src.includeDescendants
      ? await expandDescendants(base, headers, seeds, { maxDepth: src.maxDepth ?? 10, limit, purpose })
      : seeds;
    log.step(`Confluence 対象ページ ${ids.length} 件（起点 ${seeds.length} 件）`);
    raw = await fetchPagesByIds(base, headers, ids.slice(0, limit), purpose);
  } else {
    const cql = buildCql(src);
    if (src.cql || src.labels?.length || src.titleContains || src.updatedWithinDays) {
      // ---- B) 条件検索 ----
      mode = 'cql';
      log.step(`Confluence CQL: ${cql}`);
      raw = await fetchByCql(base, headers, cql, limit, purpose);
    } else {
      // ---- C) スペース全体 ----
      mode = 'space';
      let spaceId = src.spaceId || null;
      if (!spaceId && src.spaceKey) {
        const sp = await httpJson(`${base}/api/v2/spaces?keys=${encodeURIComponent(src.spaceKey)}&limit=1`, { headers, purpose });
        spaceId = sp?.results?.[0]?.id;
        if (!spaceId) throw new Error(`Confluence スペース "${src.spaceKey}" が見つかりません (${base})`);
      }
      if (!spaceId) {
        throw new Error(
          `sources[${src.id}] の取り込み範囲が指定されていません。\n` +
          `次のいずれかを設定してください: pageUrls / pageIds / spaceKey / cql / labels\n` +
          `URL から設定を作るには: context-grill resolve "<ページのURL>"`);
      }
      let url = `${base}/api/v2/pages?body-format=storage&limit=${pageSize}&space-id=${spaceId}`;
      if (src.status) url += `&status=${encodeURIComponent(src.status)}`;
      while (url && raw.length < limit) {
        const res = await httpJson(url, { headers, purpose });
        const results = res?.results || [];
        raw.push(...results);
        const nx = res?._links?.next;
        url = nx && results.length ? (nx.startsWith('http') ? nx : base.replace(/\/wiki$/, '') + nx) : null;
      }
      raw = raw.slice(0, limit);
    }
  }

  const docs = [];
  const seen = new Set();
  let filtered = 0;
  for (const p of raw) {
    if (!p?.id || seen.has(String(p.id))) continue;
    seen.add(String(p.id));
    const title = p.title || '';
    if (!isIncluded(title, src.include || [], src.exclude || [])) { filtered++; continue; }
    docs.push(toDoc(src, base, p, cache));
  }
  log.step(`Confluence (${mode}): ${docs.length} ページ取得${filtered ? ` / タイトル条件で除外 ${filtered}` : ''}`);

  return { docs, state: { syncedAt: new Date().toISOString(), count: docs.length, mode, seeds: seeds.length } };
}
