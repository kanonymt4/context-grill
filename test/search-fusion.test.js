import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { syncSources, buildIndex } from '../src/index/ingest.js';
import { IndexStore } from '../src/index/store.js';
import { hybridSearch, fuseScores } from '../src/index/search.js';
import { TASKS, planQueries } from '../src/tasks/index.js';

// 検索の融合と加点の受け入れテスト。
// 加点（パス・タイトル一致 / 種別 / ソース優先度）は「僅差の順位付け」にだけ効き、
// BM25 が桁違いに強い文書を追い越さないこと。
// 各ケースは次の変異で落ちることを確かめてある:
//  - 旧実装（RRF + 加点 ×30）: 例 1・例 2・種別の大差
//  - RRF のまま加点だけ小さくする（×30 を外す / 乗法にする）: 例 1
//  - 加点をすべて外す: タイトルの僅差・ソース優先度・種別の僅差

const FILES = {
  // 例 1: BM25 では retry.js が桁違いに強い。payment-spec は辞書の橋渡し（max → 上限）でタイトルに当たるだけ
  'repo/src/retry.js': `// 外部 API 呼び出しの再試行
export const MAX_RETRIES = 5;
export const BASE_DELAY_MS = 200;

export async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (attempt + 1 >= MAX_RETRIES) break;
      await sleep(BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastErr;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
`,
  'wiki/docs/payment-spec.md': '# 決済の上限\n\n1 回の決済で扱える金額には上限がある。上限を超える場合は分割して申請する。\nカード会社ごとの与信枠は別途確認すること。\n',
  // 例 2: session.js が BM25 で突出。他の文書はタイトルの「の」や漢字 1 字が当たるだけ
  'repo/src/session.js': `// セッションの有効期限の検証
export function validateSessionExpiry(session, now = Date.now()) {
  // 有効期限が切れていれば拒否する（有効期限の検証）
  if (!session || !session.expiresAt) return false;
  if (session.expiresAt <= now) return false;   // expiry
  return true;
}
export function refreshSession(session, ttlMs) {
  return { ...session, expiresAt: Date.now() + ttlMs };
}
`,
  'wiki/docs/ops-keys.md': '# 鍵の保管\n\n鍵は KMS で保管し、運用担当のみが参照できる。年に一度の点検で利用状況を確認する。\n',
  // 僅差（BM25 で約 6% 差）なら、タイトルの一部が一致する文書が上に来る
  'wiki/docs/invoice-issue.md': '# 請求書の扱い\n\n月末に発行して顧客へ送付する。控えは顧客ポータルから取得できる。\n',
  'wiki/docs/billing-flow.md': '# 課金の流れ\n\n月末締めで請求書を作る。請求書の発行後に入金を確認する。請求書の発行が遅れたら翌営業日に請求書の発行を行う。\n照合は経理担当が担う。\n',
  // 同一パス・同一内容を 2 ソースに置く（索引の idx は mirror が先）
  'mirror/src/audit.js': 'export function writeAuditLog(event) { return appendAuditRecord(event); }\n',
  'repo/src/audit.js': 'export function writeAuditLog(event) { return appendAuditRecord(event); }\n',
  // 種別の僅差（BM25 で約 1% 差、コードが上）。spec では文書を上にする
  'wiki/docs/export.md': '# CSV 出力\n\n注文一覧を CSV で出力する。出力の文字コードは UTF-8。\n',
  'repo/src/exporter.js': "// 注文一覧を CSV で出力する。一覧の出力の本体\nexport function exportOrders(orders) { return toCsv(orders, 'UTF-8'); }\n",
  // 種別の大差（BM25 で約 4 倍、コードが上）。spec でもコードを上にする
  'repo/src/csv.js': `export const CSV_DELIMITER = ',';
export function toCsv(rows) {
  return rows.map((r) => r.join(CSV_DELIMITER)).join('\\n');
}
export function parseCsv(text) { return text.split('\\n').map((l) => l.split(CSV_DELIMITER)); }
// CSV_DELIMITER を変えるときは parseCsv も確認する
`,
  'wiki/docs/csv-format.md': '# CSV の区切り文字\n\n区切り文字はカンマ。\n',
};
// 無関係な文書（idf と、CJK 1-gram を落とす df/N の規則を現実に近づける）
[
  ['利用規約の改定', '利用規約を改定した場合は、改定日の 30 日前までに告知する。'],
  ['問い合わせ窓口', '問い合わせは平日の日中に受け付ける。回答は 3 営業日以内。'],
  ['障害報告の書き方', '障害が起きたら、発生時刻・影響範囲・暫定対応を報告する。'],
  ['リリースの手順', 'リリースの前にステージングで確認し、承認を得てから本番に出す。'],
  ['休日の運用', '休日は当番が一次対応を行い、必要なら担当者を呼び出す。'],
  ['用語集', '本書で使う用語の定義をまとめる。顧客・注文・商品の関係を図にする。'],
  ['会議の進め方', '会議の議題は前日までに共有し、議事録は当日中に残す。'],
  ['採番の規則', '注文番号は日付と連番の組み合わせで採番する。'],
  ['画面の一覧', '管理画面の一覧と、それぞれの権限の対応を示す。'],
  ['在庫の引当', '注文が確定した時点で在庫を引き当てる。引当に失敗したら注文を保留する。'],
].forEach(([t, b], i) => { FILES[`wiki/docs/misc-${i}.md`] = `# ${t}\n\n${b}\n`; });
['logger', 'router', 'cache', 'queue', 'mailer', 'metrics', 'db', 'auth'].forEach((n) => {
  FILES[`repo/src/${n}.js`] = `// ${n} module\nexport function init${n[0].toUpperCase()}${n.slice(1)}(opts) {\n  return { name: '${n}', opts };\n}\n`;
});

let ctx;
async function setup() {
  if (ctx) return ctx;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-fusion-'));
  for (const [rel, body] of Object.entries(FILES)) {
    await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fsp.writeFile(path.join(dir, rel), body);
  }
  await fsp.writeFile(path.join(dir, 'context-grill.config.json'), JSON.stringify({
    project: 'fusion',
    sources: [
      { id: 'mirror', type: 'local', path: path.join(dir, 'mirror'), priority: 0.5 },
      { id: 'repo', type: 'local', path: path.join(dir, 'repo'), priority: 1.0 },
      { id: 'wiki', type: 'local', path: path.join(dir, 'wiki'), priority: 0.9 },
    ],
    llm: { provider: 'dry', model: 'dry' },
  }));
  const config = await loadConfig(path.join(dir, 'context-grill.config.json'));
  const report = await syncSources(config, { summary: false });
  assert.ok(report.every((r) => r.ok), JSON.stringify(report));
  await buildIndex(config, { embed: false });
  const store = await IndexStore.open(path.join(dir, '.context-grill', 'index'));
  const sourcePriority = {};
  config.sources.forEach((s, i) => { sourcePriority[s.id] = s.priority ?? (1 - i * 0.05); });
  ctx = { dir, config, store, sourcePriority };
  return ctx;
}

test.after(async () => {
  if (!ctx) return;
  await ctx.store.close();
  await fsp.rm(ctx.dir, { recursive: true, force: true });
});

/** CLI の search と同じ呼び方（クエリ 1 件、種別・ソースの優先度なし） */
async function cliSearch(q) {
  const { store, config } = await setup();
  return hybridSearch(store, { queries: [q], config, k: 10, kindPriors: {}, sourcePriority: {} });
}
/** run_task と同じ呼び方（planQueries の複数クエリ、タスクの種別事前確率、ソース優先度） */
async function taskSearch(taskId, instruction) {
  const { store, config, sourcePriority } = await setup();
  return hybridSearch(store, {
    queries: planQueries(taskId, instruction, { max: 6 }), config, k: 10,
    kindPriors: TASKS[taskId].kindPriors, sourcePriority,
  });
}
/** BM25 だけの順位（fixture の前提の確認用） */
async function bm25Scores(q) {
  const { store } = await setup();
  const { queryTerms } = await import('../src/index/tokenize.js');
  const { bridgeTerms } = await import('../src/index/glossary.js');
  const terms = queryTerms(q);
  for (const [t, w] of bridgeTerms(q)) if (!terms.has(t)) terms.set(t, w);
  const out = new Map();
  for (const r of store.bm25(terms, 60)) out.set(`${store.meta[r.idx].sourceId}:${store.meta[r.idx].path}`, r.score);
  return out;
}

const key = (r) => `${r.sourceId}:${r.path}`;
function assertFirst(results, hi, lo) {
  const keys = results.map(key);
  assert.equal(keys[0], hi, `1 位は ${hi} であるべき: ${keys.slice(0, 5).join(', ')}`);
  const l = keys.indexOf(lo);
  assert.ok(l === -1 || l > 0, `${lo} は ${hi} より下であるべき: ${keys.slice(0, 5).join(', ')}`);
}

test('融合: 例 1 — BM25 が桁違いに強いコードは、辞書の橋渡しでタイトルに当たった文書に抜かれない (CLI)', async () => {
  const bm = await bm25Scores('MAX_RETRIES');
  assert.ok(bm.get('repo:src/retry.js') > 5 * bm.get('wiki:docs/payment-spec.md'), '前提: BM25 で retry.js が桁違いに強い');
  assertFirst(await cliSearch('MAX_RETRIES'), 'repo:src/retry.js', 'wiki:docs/payment-spec.md');
});

test('融合: 例 2 — タイトルの助詞・漢字 1 字の一致で、BM25 1 位が圏外に落ちない (CLI と spec)', async () => {
  assertFirst(await cliSearch('有効期限の検証'), 'repo:src/session.js', 'wiki:docs/ops-keys.md');
  assertFirst(await taskSearch('spec', '有効期限の検証'), 'repo:src/session.js', 'wiki:docs/ops-keys.md');
});

test('融合: BM25 が僅差なら、タイトルの一部が一致する文書が上に来る (CLI)', async () => {
  const bm = await bm25Scores('請求書の発行');
  const a = bm.get('wiki:docs/billing-flow.md'), b = bm.get('wiki:docs/invoice-issue.md');
  assert.ok(a > b && b > 0.9 * a, `前提: BM25 では billing-flow が僅差で上 (${a} / ${b})`);
  assertFirst(await cliSearch('請求書の発行'), 'wiki:docs/invoice-issue.md', 'wiki:docs/billing-flow.md');
});

test('融合: 同一内容なら、ソース優先度の高い方が上に来る (bug)', async () => {
  const bm = await bm25Scores('writeAuditLog');
  assert.equal(bm.get('repo:src/audit.js'), bm.get('mirror:src/audit.js'), '前提: BM25 は同点');
  assertFirst(await taskSearch('bug', 'writeAuditLog'), 'repo:src/audit.js', 'mirror:src/audit.js');
});

test('融合: 種別の事前確率は僅差なら効き、大差なら BM25 を覆さない (spec)', async () => {
  const near = await bm25Scores('注文一覧の CSV 出力');
  const c = near.get('repo:src/exporter.js'), d = near.get('wiki:docs/export.md');
  assert.ok(c > d && d > 0.95 * c, `前提: BM25 ではコードが僅差で上 (${c} / ${d})`);
  assertFirst(await taskSearch('spec', '注文一覧の CSV 出力'), 'wiki:docs/export.md', 'repo:src/exporter.js');

  const far = await bm25Scores('CSV_DELIMITER');
  assert.ok(far.get('repo:src/csv.js') > 3 * far.get('wiki:docs/csv-format.md'), '前提: BM25 でコードが大差で上');
  assertFirst(await taskSearch('spec', 'CSV_DELIMITER'), 'repo:src/csv.js', 'wiki:docs/csv-format.md');
});

test('融合: パス一致の補正は乗法。BM25 が 1.5 倍の文書を、パスが完全に一致するだけでは追い越さない', async () => {
  // idx 2 だけパスがクエリに一致する。BM25 は 10 / 4.5 / 3。本文は互いに別の 1 語で、MMR の類似度は 0
  const meta = [0, 1, 2].map((i) => ({
    docId: `d${i}`, path: i === 2 ? 'src/zeta.js' : `src/f${i}.js`, title: i === 2 ? 'src/zeta.js' : `src/f${i}.js`, kind: 'code', sourceId: 's',
  }));
  const store = {
    dims: 0, meta,
    textOf: (i) => `body${i}`,
    vecAt: () => null,
    chunkAt: (i) => ({ ...meta[i], idx: i }),
    bm25: () => [{ idx: 0, score: 10 }, { idx: 1, score: 4.5 }, { idx: 2, score: 3 }],
    vectorSearch: () => [],
  };
  const config = {
    retrieval: {
      embedding: { provider: 'none' }, glossaryBridge: false,
      hybrid: { final: 3, mmrLambda: 0.72, perQueryTop: 10 },
      boosts: { pathMatch: 0.35, kindPrior: 0, sourcePriority: 0 },
    },
  };
  const res = await hybridSearch(store, { queries: ['zeta'], config });
  // 乗法: idx 2 = 0.3 × 1.35 = 0.405 < idx 1 = 0.45。
  // 加算（0.3 + 0.35 × 30/61 ≒ 0.472）なら idx 1 を、RRF + 乗法（1.35/63 > 1/61）なら idx 0 を追い越す
  assert.deepEqual(res.map((r) => r.idx), [0, 1, 2]);
  assert.ok(Math.abs(res[2].score - 0.405) < 1e-9, `idx 2 の score: ${res[2].score}`);
});

test('fuseScores: BM25 は max で、ベクトルは min-max で正規化してリスト数で割る。同点は idx 昇順', () => {
  const out = fuseScores([
    { kind: 'bm25', items: [{ idx: 3, score: 10 }, { idx: 1, score: 5 }] },
    { kind: 'vector', items: [{ idx: 1, score: 0.5 }, { idx: 2, score: 0.4 }, { idx: 3, score: 0.3 }] },
  ]);
  const got = Object.fromEntries(out.map((r) => [r.idx, Number(r.score.toFixed(6))]));
  assert.deepEqual(got, { 3: 0.5, 1: 0.75, 2: 0.25 });
  assert.deepEqual(out.map((r) => r.idx), [1, 3, 2]);
  // 同点
  const tie = fuseScores([{ kind: 'bm25', items: [{ idx: 7, score: 2 }, { idx: 4, score: 2 }] }]);
  assert.deepEqual(tie.map((r) => r.idx), [4, 7]);
  // スコアの無いリストは黙って通さない
  assert.throws(() => fuseScores([{ kind: 'bm25', items: [{ idx: 0 }] }]), /スコアが数値ではありません/);
});

/** 重複排除（MMR）の検査用 store。idx 0〜3 は同一本文（重複）、idx 4 以降は互いに別の本文 */
function dupStore(scores, texts) {
  const meta = scores.map((_, i) => ({ docId: `d${i}`, path: `src/f${i}.md`, title: `t${i}`, kind: 'doc', sourceId: 's' }));
  return {
    dims: 0, meta,
    textOf: (i) => texts[i],
    vecAt: () => null,
    chunkAt: (i) => ({ ...meta[i], idx: i }),
    bm25: () => scores.map((score, idx) => ({ idx, score })),
    vectorSearch: () => [],
  };
}
const dupConfig = (final) => ({
  retrieval: {
    embedding: { provider: 'none' }, glossaryBridge: false,
    hybrid: { final, mmrLambda: 0.72, perQueryTop: 20 },
    boosts: { pathMatch: 0, kindPrior: 0, sourcePriority: 0 },
  },
});
const DUP_TEXT = 'alpha beta gamma delta epsilon zeta eta theta';
const distinct = (n) => Array.from({ length: n }, (_, i) => `unique${i}a unique${i}b unique${i}c unique${i}d`);

test('MMR: 同一本文のチャンクは、別の本文の候補が残っている間は上位 k に 1 つしか入らない', async () => {
  // 重複 4 件は BM25 が最大、別の本文 4 件は半分の BM25（正規化後の関連度は 0.5）
  const scores = [10, 10, 10, 10, 5, 5, 5, 5];
  const texts = [DUP_TEXT, DUP_TEXT, DUP_TEXT, DUP_TEXT, ...distinct(4)];
  const res = await hybridSearch(dupStore(scores, texts), { queries: ['q'], config: dupConfig(5) });
  const dups = res.filter((r) => r.idx <= 3).length;
  assert.equal(dups, 1, `重複は 1 件だけ: ${res.map((r) => r.idx).join(',')}`);
  assert.equal(res.length, 5);
});

test('MMR: 別の本文の候補が足りなければ、重複で枠を埋める（件数を減らさない）', async () => {
  const scores = [10, 10, 10, 10, 5];
  const texts = [DUP_TEXT, DUP_TEXT, DUP_TEXT, DUP_TEXT, ...distinct(1)];
  const res = await hybridSearch(dupStore(scores, texts), { queries: ['q'], config: dupConfig(5) });
  assert.equal(res.length, 5);
  assert.deepEqual(res.map((r) => r.idx).sort(), [0, 1, 2, 3, 4]);
});

test('MMR: 重複の疑いが無い（語が一部重なるだけの）候補は、重複扱いで後回しにされない', async () => {
  // 語が半分重なる程度（Jaccard 約 0.33）は重複とみなさない。BM25 の大きい順に並ぶ
  // idx 1 は idx 0 と語が半分重なる（BM25 は 0.9）。idx 2 は無関係な本文（BM25 は 0.5）
  const texts = ['alpha beta gamma delta epsilon zeta', 'alpha beta gamma xray yankee zulu', 'papa quebec romeo sierra tango uniform'];
  const res = await hybridSearch(dupStore([10, 9, 5], texts), { queries: ['q'], config: dupConfig(3) });
  assert.deepEqual(res.map((r) => r.idx), [0, 1, 2]);
});
