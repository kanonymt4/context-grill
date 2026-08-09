import { adfToText } from '../util/html.js';
import { log } from '../util/log.js';
import { makeDoc, httpJson, requireEnv } from './base.js';

function authHeader(src) {
  const emailEnv = src.auth?.emailEnv || 'ATLASSIAN_EMAIL';
  const tokenEnv = src.auth?.tokenEnv || 'ATLASSIAN_API_TOKEN';
  const email = requireEnv(emailEnv);
  const tk = requireEnv(tokenEnv);
  return 'Basic ' + Buffer.from(`${email}:${tk}`).toString('base64');
}

export async function syncJira(src) {
  const base = String(src.baseUrl).replace(/\/+$/, '');
  const headers = { Authorization: authHeader(src), Accept: 'application/json', 'Content-Type': 'application/json' };
  const jql = src.jql || (src.projectKey ? `project = ${src.projectKey} ORDER BY updated DESC` : 'ORDER BY updated DESC');
  const limit = src.limit ?? 200;
  const fields = src.fields || ['summary', 'description', 'status', 'issuetype', 'priority', 'labels', 'components', 'created', 'updated', 'resolution', 'fixVersions', 'parent'];

  const docs = [];
  let nextPageToken = null;
  while (docs.length < limit) {
    const body = { jql, maxResults: Math.min(100, limit - docs.length), fields };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const res = await httpJson(`${base}/rest/api/3/search/jql`, { method: 'POST', headers, body: JSON.stringify(body), purpose: `jira:${src.id}` });
    const issues = res?.issues || [];
    for (const it of issues) {
      const f = it.fields || {};
      const desc = typeof f.description === 'string' ? f.description : adfToText(f.description);
      const text = [
        `# ${it.key}: ${f.summary || ''}`,
        `type: ${f.issuetype?.name} / status: ${f.status?.name} / priority: ${f.priority?.name}`,
        `labels: ${(f.labels || []).join(', ') || '(none)'} / components: ${(f.components || []).map((c) => c.name).join(', ') || '(none)'}`,
        `created: ${f.created} / updated: ${f.updated} / resolution: ${f.resolution?.name || '未解決'}`,
        '', desc || '(説明なし)',
      ].join('\n');
      docs.push(makeDoc({
        sourceId: src.id, sourceType: 'jira', docPath: `issues/${it.key}`, title: `${it.key} ${f.summary || ''}`,
        kind: 'ticket', lang: 'md', text,
        url: `${base}/browse/${it.key}`, version: f.updated,
        meta: { key: it.key, status: f.status?.name, type: f.issuetype?.name },
      }));
    }
    nextPageToken = res?.nextPageToken;
    if (!nextPageToken || issues.length === 0) break;
  }
  log.step(`Jira: ${docs.length} 件取得`);
  return { docs, state: { syncedAt: new Date().toISOString(), count: docs.length, jql } };
}
