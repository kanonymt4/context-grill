import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { matchGlob, isIncluded, stableStringify } from '../src/util/misc.js';
import { estimateTokens, truncateToTokens } from '../src/util/tokens.js';
import { tokenize, queryTerms, splitIdentifier } from '../src/index/tokenize.js';
import { chunkCode, chunkText } from '../src/index/chunk.js';
import { IndexBuilder, IndexStore } from '../src/index/store.js';
import { buildEvidencePack, renderEvidenceBlock } from '../src/index/pack.js';
import { validate, extractJson } from '../src/llm/jsonschema.js';
import { verify } from '../src/verify/gate.js';
import { envelopeSchema, planQueries, TASKS } from '../src/tasks/index.js';
import { scanDocument } from '../src/analysis/rules.js';
import { htmlToText, adfToText } from '../src/util/html.js';

test('glob: 代表的なパターン', () => {
  assert.ok(matchGlob('src/a/b.js', 'src/**'));
  assert.ok(matchGlob('a/node_modules/x.js', '**/node_modules/**'));
  assert.ok(!matchGlob('src/a.ts', '**/*.js'));
  assert.ok(matchGlob('a.spec.ts', '*.{spec,test}.ts'));
  assert.ok(isIncluded('src/x.ts', ['src/**'], ['**/*.d.ts']));
  assert.ok(!isIncluded('src/x.d.ts', ['src/**'], ['**/*.d.ts']));
});

test('stableStringify: キー順が安定する', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
});

test('トークン見積り: 日本語と英語で単調増加・切り詰めが効く', () => {
  assert.ok(estimateTokens('hello world') > 0);
  assert.ok(estimateTokens('これは日本語のテキストです') > estimateTokens('日本語'));
  const long = 'あ'.repeat(1000);
  assert.ok(estimateTokens(truncateToTokens(long, 100)) <= 110);
});

test('トークナイザ: 識別子分解と CJK bigram', () => {
  const t = tokenize('getUserToken_v2');
  assert.ok(t.includes('getusertoken_v2'));
  assert.ok(t.includes('user'));
  assert.ok(t.includes('token'));
  assert.deepEqual(splitIdentifier('HTTPServerError'), ['http', 'server', 'error']);
  const j = tokenize('認証トークン');
  assert.ok(j.includes('認証'));
  assert.ok(j.includes('認'));
  assert.ok(!queryTerms('the of する').has('the'));
});

test('コードチャンク: 行番号が原文と一致する', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `const v${i} = ${i};`);
  const doc = { docId: 's:a.js', sourceId: 's', sourceType: 'local', path: 'a.js', title: 'a.js', kind: 'code', lang: 'js', url: null, version: '1', meta: {}, text: lines.join('\n') };
  const chunks = chunkCode(doc, { maxLines: 50, overlapLines: 5, maxChars: 100000 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    const expected = lines.slice(c.start - 1, c.end).join('\n');
    assert.equal(c.text, expected, `${c.id} の行範囲が本文と一致しない`);
  }
});

test('文書チャンク: 見出し階層をタイトルに持つ', () => {
  const doc = { docId: 's:d.md', sourceId: 's', sourceType: 'local', path: 'd.md', title: '設計書', kind: 'doc', lang: 'md', url: null, version: '1', meta: {}, text: '# 概要\nあ\n\n## 認証\n認証はトークンで行う\n' };
  const chunks = chunkText(doc, { maxChars: 2000, overlapChars: 100 });
  assert.ok(chunks.some((c) => c.title.includes('認証')));
});

test('索引: BM25 で該当チャンクが上位に来る', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-'));
  const b = new IndexBuilder(dir);
  await b.start();
  const mk = (i, text, p) => ({ id: `s:${p}#0`, docId: `s:${p}`, sourceId: 's', sourceType: 'local', path: p, title: p, kind: 'code', lang: 'js', url: null, version: '1', meta: {}, start: 1, end: 3, hash: String(i), ntok: 10, text });
  b.add(mk(0, 'function refundPayment(orderId) { return retryWithBackoff(orderId); }', 'refund.js'));
  b.add(mk(1, 'const colors = ["red", "green"]; // 無関係', 'colors.js'));
  b.add(mk(2, '決済のリトライは最大3回まで行う', 'doc.md'));
  await b.finish({ indexKey: 'k' });
  const store = await IndexStore.open(dir);
  const hits = store.bm25(queryTerms('refundPayment retry'), 3);
  assert.equal(store.meta[hits[0].idx].path, 'refund.js');
  assert.equal(store.textOf(hits[0].idx).includes('refundPayment'), true);
  const ja = store.bm25(queryTerms('決済 リトライ'), 3);
  assert.equal(store.meta[ja[0].idx].path, 'doc.md');
  await store.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('証拠パック: トークン予算を超えない / ID が連番', () => {
  const mk = (i) => ({ docId: `d${i}`, sourceId: 's', sourceType: 'github', kind: 'code', path: `f${i}.js`, title: `f${i}`, start: 1, end: 10, version: 'abc', url: 'https://example.com/f', score: 10 - i, text: 'x'.repeat(2000) });
  const pack = buildEvidencePack([mk(0), mk(1), mk(2), mk(3)], { budgetTokens: 800 });
  assert.ok(pack.tokens <= 800);
  assert.deepEqual(pack.items.map((e) => e.id), pack.items.map((_, i) => `E${i + 1}`));
  assert.ok(renderEvidenceBlock(pack).includes('<evidence id="E1"'));
});

test('JSON スキーマ検証と JSON 抽出', () => {
  const s = { type: 'object', required: ['a'], properties: { a: { type: 'string', enum: ['x'] } }, additionalProperties: false };
  assert.equal(validate(s, { a: 'x' }).length, 0);
  assert.ok(validate(s, { a: 'y' }).length > 0);
  assert.ok(validate(s, { b: 1 }).length > 0);
  assert.deepEqual(extractJson('前置き\n```json\n{"a":1}\n```\n後書き'), { a: 1 });
  assert.deepEqual(extractJson('{"a":"}\\""}'), { a: '}"' });
});

test('検証ゲート: 偽の証拠 ID と引用不一致を検出して除去する', () => {
  const pack = { items: [{ id: 'E1', label: 'repo/a.js:1-3', text: 'function login(user) {\n  return verify(user);\n}' }] };
  const schema = envelopeSchema(TASKS.spec.itemTypes);
  const policy = { requireCitations: true, minEvidencePerItem: 1, requireVerbatimQuote: true, dropUnverifiedItems: true, forbidSpeculativeLanguage: true };
  const result = {
    summary: 'まとめ',
    items: [
      { id: 'I1', type: 'behavior', title: '正しい', statement: 'login は verify を呼ぶ', evidence: ['E1'], quotes: [{ evidence: 'E1', text: 'return verify(user);' }], confidence: 'high' },
      { id: 'I2', type: 'behavior', title: '偽の証拠', statement: 'x', evidence: ['E99'], confidence: 'high' },
      { id: 'I3', type: 'behavior', title: '捏造引用', statement: 'y', evidence: ['E1'], quotes: [{ evidence: 'E1', text: 'return authorize(user);' }], confidence: 'high' },
      { id: 'I4', type: 'behavior', title: '証拠なし', statement: 'z', evidence: [], confidence: 'high' },
    ],
    open_questions: [],
  };
  const v = verify(result, { pack, schema, policy, taskId: 'spec' });
  assert.equal(v.ok, false);
  assert.deepEqual(v.cleaned.items.map((i) => i.id), ['I1']);
  assert.equal(v.stats.itemsRejected, 3);
  assert.ok(v.violations.some((x) => x.code === 'E_QUOTE_MISMATCH'));
  assert.ok(v.violations.some((x) => x.code === 'E_BAD_EVIDENCE'));
  assert.ok(v.violations.some((x) => x.code === 'E_NO_EVIDENCE'));
});

test('検証ゲート: 推測表現 + high 確度は不合格', () => {
  const pack = { items: [{ id: 'E1', label: 'x', text: 'abc' }] };
  const schema = envelopeSchema(TASKS.spec.itemTypes);
  const policy = { requireCitations: true, minEvidencePerItem: 1, requireVerbatimQuote: true, dropUnverifiedItems: true, forbidSpeculativeLanguage: true };
  const v = verify({ summary: 's', open_questions: [], items: [{ id: 'I1', type: 'behavior', title: 't', statement: 'おそらくキャッシュされる', evidence: ['E1'], confidence: 'high' }] },
    { pack, schema, policy, taskId: 'spec' });
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.code === 'E_SPECULATION'));
});

test('クエリ計画: 決定的（同じ入力なら常に同じクエリ）', () => {
  const a = planQueries('bug', '"TimeoutError" が payment_service.js で出る', { max: 6 });
  const b = planQueries('bug', '"TimeoutError" が payment_service.js で出る', { max: 6 });
  assert.deepEqual(a, b);
  assert.ok(a.includes('TimeoutError'));
  assert.ok(a.some((q) => q.includes('payment_service.js')));
});

test('静的解析ルール: 代表的な検出と誤検知抑制', () => {
  const doc = (text, p = 'src/a.js') => ({ sourceId: 's', sourceType: 'github', path: p, kind: 'code', lang: 'js', url: null, text });
  const f1 = scanDocument(doc('const key = "sk_live_ABCDEFGHIJKLMNOP123";'));
  assert.ok(f1.some((f) => f.ruleId === 'SEC-SECRET-GENERIC'));
  const f2 = scanDocument(doc('const key = process.env.API_KEY;'));
  assert.ok(!f2.some((f) => f.ruleId === 'SEC-SECRET-GENERIC'));
  const f3 = scanDocument(doc('const opts = { rejectUnauthorized: false };'));
  assert.ok(f3.some((f) => f.ruleId === 'SEC-TLS-DISABLED' && f.severity === 'critical'));
  const f4 = scanDocument(doc('eval(userInput);'));
  assert.ok(f4.some((f) => f.ruleId === 'SEC-EVAL'));
  assert.equal(scanDocument(doc('eval(x);', 'test/a.js')).length, 0, 'テストパスは既定で除外');
  assert.equal(f4[0].line, 1);
});

test('HTML / ADF 変換', () => {
  assert.ok(htmlToText('<h1>題</h1><p>本文</p>').startsWith('# 題'));
  assert.equal(adfToText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'あ' }] }] }).trim(), 'あ');
});

test('URL 解析: GitHub / Confluence / Jira の指定方法', async () => {
  const { urlToSource, parseConfluenceUrl, parseGithubUrl } = await import('../src/util/urls.js');

  const repo = urlToSource('https://github.com/acme/api-service/tree/develop/services/payment').source;
  assert.equal(repo.repo, 'acme/api-service');
  assert.equal(repo.ref, 'develop');
  assert.deepEqual(repo.include, ['services/payment/**']);

  const file = urlToSource('https://github.com/acme/api/blob/main/src/auth.js').source;
  assert.deepEqual(file.include, ['src/auth.js']);

  const ghe = urlToSource('https://git.corp.example.com/acme/api').source;
  assert.equal(ghe.host, 'git.corp.example.com');
  assert.equal(ghe.apiBaseUrl, 'https://git.corp.example.com/api/v3');

  const page = parseConfluenceUrl('https://acme.atlassian.net/wiki/spaces/ENG/pages/393217/決済仕様');
  assert.equal(page.pageId, '393217');
  assert.equal(page.spaceKey, 'ENG');
  assert.equal(page.baseUrl, 'https://acme.atlassian.net/wiki');
  assert.equal(page.title, '決済仕様');

  const legacy = parseConfluenceUrl('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=98765');
  assert.equal(legacy.pageId, '98765');

  const space = parseConfluenceUrl('https://acme.atlassian.net/wiki/spaces/ENG/overview');
  assert.equal(space.kind, 'space');
  assert.equal(space.spaceKey, 'ENG');

  const pageSrc = urlToSource('https://acme.atlassian.net/wiki/spaces/ENG/pages/393217/決済仕様').source;
  assert.deepEqual(pageSrc.pageIds, ['393217']);
  assert.equal(pageSrc.includeDescendants, true);

  const short = urlToSource('https://acme.atlassian.net/wiki/x/AbCdEf');
  assert.equal(short.source, null);
  assert.ok(short.notes[0].includes('短縮リンク'));

  const jira = urlToSource('https://acme.atlassian.net/browse/ENG-1234').source;
  assert.equal(jira.type, 'jira');
  assert.equal(jira.jql, 'key = ENG-1234');

  assert.equal(parseGithubUrl('https://example.com/foo'), null);
});
