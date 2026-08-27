import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import fsp from 'node:fs/promises';

import { matchGlob, isIncluded, stableStringify } from '../src/util/misc.js';
import { estimateTokens, truncateToTokens } from '../src/util/tokens.js';
import { tokenize, queryTerms, splitIdentifier } from '../src/index/tokenize.js';
import { chunkCode, chunkText } from '../src/index/chunk.js';
import { IndexBuilder, IndexStore, layout, writeVectors, latestGen } from '../src/index/store.js';
import { buildEvidencePack, renderEvidenceBlock } from '../src/index/pack.js';
import { validate, extractJson } from '../src/llm/jsonschema.js';
import { verify } from '../src/verify/gate.js';
import { envelopeSchema, planQueries, TASKS } from '../src/tasks/index.js';
import { scanDocument } from '../src/analysis/rules.js';
import { htmlToText, adfToText } from '../src/util/html.js';
import { buildEmbeddingRequest, parseEmbeddingResponse, embedChunks, embedCacheKey, embedCacheNamespace } from '../src/index/embed.js';
import { initEgress } from '../src/util/egress.js';

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


test('索引: 開いたストアは作り直しの影響を受けない（スナップショット）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-'));
  const mk = (i, text, p) => ({ id: `s:${p}#0`, docId: `s:${p}`, sourceId: 's', sourceType: 'local', path: p, title: p, kind: 'code', lang: 'js', url: null, version: '1', meta: {}, start: 1, end: 3, hash: String(i), ntok: 10, text });
  const build = async (chunks) => {
    const b = new IndexBuilder(dir);
    await b.start();
    for (const c of chunks) b.add(c);
    await b.finish({ indexKey: 'k' });
  };

  await build([
    mk(0, 'function refundPayment(orderId) { return retryWithBackoff(orderId); }', 'refund.js'),
    mk(1, 'const colors = ["red", "green"];', 'colors.js'),
  ]);
  const store = await IndexStore.open(dir);

  // 開いたまま索引を作り直す（チャンク数も内容も変わる）
  await build([
    mk(0, 'function refundPayment(orderId) { return retryWithBackoff(orderId); }', 'refund.js'),
    mk(1, 'const colors = ["red", "green"];', 'colors.js'),
    mk(2, 'function refundV2() { return "ZZTOPSECRETMARKER"; }', 'refund_v2.js'),
  ]);

  // docs.txt は fd 保持で古い実体を読むが、postings はパス指定で新しい中身を読む。
  // この非対称のため store.meta（2 件）に無い doc id が postings から返り、
  // store.meta[idx] が undefined になる。
  const hits = store.bm25(queryTerms('refundPayment retry'), 3);
  for (const h of hits) {
    assert.ok(store.meta[h.idx], `postings が meta に無い doc id ${h.idx} を返した（meta は ${store.meta.length} 件）`);
  }
  assert.equal(store.meta[hits[0].idx].path, 'refund.js');
  assert.equal(store.textOf(hits[0].idx).includes('refundPayment'), true);

  // 開いた時点の索引に無い語は、作り直し後も引けない（スナップショットである）
  assert.equal(store.bm25(queryTerms('ZZTOPSECRETMARKER'), 3).length, 0,
    '作り直し後に追加された語が、開いたままのストアから引けている');

  await store.close();
  await fsp.rm(dir, { recursive: true, force: true });
});
/**
 * 索引を作り直している最中に開いたストアが、単一世代の一貫した内容を返すことを確かめる。
 *
 * finish() は複数回の書き込みに分かれるので、その途中で open() すると新旧が混ざり得る。
 * 特定の書き込み順に依存したくないので、書き込み 1 回ごとに必ず止めて、そのたびに
 * 開いて中身を検査する。書き方を変えてもこのテストの意味は変わらない。
 *
 * 混ざり方は 3 通りある。件数のずれ（manifest.N / meta / lens）、meta に無い doc id が
 * postings から出てくる、meta の世代と docs.txt の世代が食い違って別文書の本文が返る。
 * どれも例外にならず静かに起きるので、個別に見る。
 */
test('索引: 作り直しの最中に開いたストアが単一世代の内容を返す', async () => {
  const mk = (i, text, p) => ({ id: `s:${p}#0`, docId: `s:${p}`, sourceId: 's', sourceType: 'local', path: p, title: p, kind: 'code', lang: 'js', url: null, version: '1', meta: {}, start: 1, end: 3, hash: String(i), ntok: 10, text });
  const OLD0 = 'function refundPayment(orderId) { return retryWithBackoff(orderId); }';
  const NEW0 = 'function refundV2(orderId) { return SECRET_ZZTOP; }';
  const V1 = [mk(0, OLD0, 'refund.js'), mk(1, 'const colors = [red, green];', 'colors.js'), mk(2, 'const a = 1;', 'a.js')];
  const V2 = [mk(0, NEW0, 'refund.js'), ...Array.from({ length: 7 }, (_, i) => mk(i + 1, `const v2_${i} = ${i};`, `v2_${i}.js`))];

  const maxDocIdIn = (store) => {
    let max = -1;
    for (let i = 0; i < 32; i++) {
      const sh = store._shard(i);
      if (!sh) continue;
      for (const term of Object.keys(sh)) {
        const arr = sh[term];
        for (let j = 0; j < arr.length; j += 2) if (arr[j] > max) max = arr[j];
      }
    }
    return max;
  };

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-'));
  const build = async (chunks) => {
    const b = new IndexBuilder(dir);
    await b.start();
    for (const c of chunks) b.add(c);
    await b.finish({ indexKey: 'k' });
  };
  await build(V1);

  // 書き込み 1 回ごとに止める。postings の 32 本は Promise.all で同時に呼ばれるので、
  // 「今来た 1 本だけ待たせる」形だと残りが素通りしてしまう（実測で 37 回中 31 回素通りした）。
  // 待ち行列に積んで全部ブロックし、テスト側が 1 本ずつ解放する。
  const waiters = [];
  let notify = null, armed = true;
  const gate = async (target) => {
    if (!armed) return;
    await new Promise((res) => {
      waiters.push({ res, target: String(target) });
      if (notify) { const n = notify; notify = null; n(); }
    });
  };
  const waitForWaiter = () => (waiters.length ? Promise.resolve() : new Promise((res) => { notify = res; }));

  const origWriteFile = fsp.writeFile;
  const origRename = fsp.rename;
  fsp.writeFile = async (p, ...rest) => { await gate(p); return origWriteFile.call(fsp, p, ...rest); };
  fsp.rename = async (a, b) => { await gate(b); return origRename.call(fsp, a, b); };

  const DONE = Symbol('done');
  const building = build(V2).then(() => DONE, (e) => e);
  const problems = [];
  let pauses = 0;
  try {
    for (;;) {
      const hit = await Promise.race([waitForWaiter().then(() => 'waiter'), building]);
      if (hit !== 'waiter') break;
      if (!waiters.length) continue;
      const w = waiters.shift();
      pauses++;
      const at = path.basename(w.target);
      let store = null;
      try {
        store = await IndexStore.open(dir);
      } catch (e) {
        problems.push(`${at} の直前で open() が失敗した: ${e.message.split(String.fromCharCode(10))[0]}`);
        w.res();
        continue;
      }
      if (store.N !== store.meta.length) problems.push(`${at} の直前: manifest.N (${store.N}) と meta の件数 (${store.meta.length}) がずれている`);
      if (store.lens.length !== store.meta.length) problems.push(`${at} の直前: lens (${store.lens.length}) と meta (${store.meta.length}) の件数がずれている`);
      const max = maxDocIdIn(store);
      if (max >= store.meta.length) problems.push(`${at} の直前: postings が meta に無い doc id ${max} を含む（meta は ${store.meta.length} 件）`);
      // どちらの世代かは meta の件数で決まる。その世代の本文が返るはず。
      const expected = store.meta.length === V1.length ? OLD0 : NEW0;
      const actual = store.textOf(0);
      if (actual !== expected) problems.push(`${at} の直前: meta の世代と docs.txt の世代が食い違っている（${JSON.stringify(actual.slice(0, 40))}）`);
      await store.close();
      w.res();
    }
  } finally {
    armed = false;
    for (const w of waiters.splice(0)) w.res();
    await building;
    fsp.writeFile = origWriteFile;
    fsp.rename = origRename;
    await fsp.rm(dir, { recursive: true, force: true });
  }

  assert.ok(pauses >= 30, `書き込みを取りこぼしている（止まった回数 ${pauses}。finish() は rename 1 + postings 32 + 4 で 37 回書く）`);
  assert.deepEqual(problems, [], `作り直しの最中に新旧が混ざった:${String.fromCharCode(10)}  ` + problems.join(String.fromCharCode(10) + '  '));
});

test('索引: 開いたストアのベクトルも作り直しの影響を受けない（スナップショット）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-'));
  const DIMS = 4;
  const mk = (i, text, p) => ({ id: `s:${p}#0`, docId: `s:${p}`, sourceId: 's', sourceType: 'local', path: p, title: p, kind: 'code', lang: 'js', url: null, version: '1', meta: {}, start: 1, end: 3, hash: String(i), ntok: 10, text });
  // ベクトルは finish() の公開前に書く必要があるため publish: false で作る
  const build = async (chunks, vectors) => {
    const b = new IndexBuilder(dir);
    await b.start();
    for (const c of chunks) b.add(c);
    await b.finish({ indexKey: 'k', dims: DIMS }, { publish: false });
    await writeVectors(dir, b.L.gen, vectors, DIMS);
    await b.publish();
  };

  await build(
    [mk(0, 'function refundPayment() {}', 'refund.js')],
    [[1, 0, 0, 0]],
  );

  const store = await IndexStore.open(dir);
  assert.deepEqual(Array.from(store.vecAt(0)), [1, 0, 0, 0], '前提: 開いた直後は第 1 世代のベクトルが読める');

  // 開いたまま、違うベクトルで作り直す
  await build(
    [mk(0, 'function refundPayment() {}', 'refund.js')],
    [[0, 1, 0, 0]],
  );

  // 旧世代の vectors.NNNN.bin は prune で消える。fd を保持していなければ
  // vecAt() は existsSync に阻まれて **例外を出さず null を返す**（静かなデグレード）。
  const v = store.vecAt(0);
  assert.ok(v, '作り直し後に vecAt() が null を返した（旧世代の fd を保持していない）');
  assert.deepEqual(Array.from(v), [1, 0, 0, 0], '開いた時点の世代ではなく別世代のベクトルを読んでいる');

  await store.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('索引: 作り直し後に初めて触ってもベクトルはスナップショットのまま', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-'));
  const DIMS = 4;
  const mk = (i, text, p) => ({ id: `s:${p}#0`, docId: `s:${p}`, sourceId: 's', sourceType: 'local', path: p, title: p, kind: 'code', lang: 'js', url: null, version: '1', meta: {}, start: 1, end: 3, hash: String(i), ntok: 10, text });
  const build = async (chunks, vectors) => {
    const b = new IndexBuilder(dir);
    await b.start();
    for (const c of chunks) b.add(c);
    await b.finish({ indexKey: 'k', dims: DIMS }, { publish: false });
    await writeVectors(dir, b.L.gen, vectors, DIMS);
    await b.publish();
  };
  await build([mk(0, 'function refundPayment() {}', 'refund.js')], [[1, 0, 0, 0]]);

  const store = await IndexStore.open(dir);
  // ここでは意図的にベクトルを読まない。直前のテストは開いた直後に vecAt() を
  // 呼ぶため _vfd が確保され、prune 後も POSIX の inode 保持で通ってしまう。
  await build([mk(0, 'function refundPayment() {}', 'refund.js')], [[0, 1, 0, 0]]);

  // vectorSearch() は毎回パス指定で開き直すため、旧世代が prune で消えていると
  // 例外を出さずに空配列を返す（静かなデグレード）。
  const hits = store.vectorSearch([1, 0, 0, 0], 5);
  assert.equal(hits.length, 1, '作り直し後に vectorSearch() が 0 件になった（旧世代の fd を保持していない）');
  assert.ok(hits[0].score > 0.99, `開いた時点の世代のベクトルを読めていない (score=${hits[0] && hits[0].score})`);

  const v = store.vecAt(0);
  assert.ok(v, '作り直し後に初めて呼んだ vecAt() が null を返した');
  assert.deepEqual(Array.from(v), [1, 0, 0, 0], '開いた時点ではなく別世代のベクトルを読んでいる');

  await store.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('索引: シャードが欠けた索引は open() の時点で原因の分かる例外になる', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-'));
  const b = new IndexBuilder(dir);
  await b.start();
  b.add({ id: 's:a.js#0', docId: 's:a.js', sourceId: 's', sourceType: 'local', path: 'a.js', title: 'a.js', kind: 'code', lang: 'js', url: null, version: '1', meta: {}, start: 1, end: 3, hash: '0', ntok: 10, text: 'function refundPayment() {}' });
  await b.finish({ indexKey: 'k' });

  // 欠損したシャードを黙って空として扱うと、その語だけ静かに 0 ヒットになる。
  // layout() は世代を受け取るので、公開済みの最新世代を渡す（渡さないと
  // pad(undefined) が "undefined" になり、存在しないパスを黙って組み立てる）。
  const gen = latestGen(dir);
  assert.ok(gen !== null, '世代が見つからない＝公開されていない');
  const shard = layout(dir, gen).postings(3);
  await fsp.rm(shard);
  await assert.rejects(
    () => IndexStore.open(dir),
    // ファイル名を直書きせず、削った当のものと照合する。世代番号のように
    // 命名規則が変わっても、テストの意図（どのシャードかが分かること）は保たれる。
    (e) => /索引が壊れています/.test(e.message) && e.message.includes(path.basename(shard)),
    'シャード欠損が、原因の分かるメッセージで報告されていない');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('索引: open(dir, { postings: false }) は postings を読まず stats() は動く', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-'));
  const b = new IndexBuilder(dir);
  await b.start();
  b.add({ id: 's:a.js#0', docId: 's:a.js', sourceId: 's', sourceType: 'local', path: 'a.js', title: 'a.js', kind: 'code', lang: 'js', url: null, version: '1', meta: {}, start: 1, end: 3, hash: '0', ntok: 10, text: 'function refundPayment() {}' });
  await b.finish({ indexKey: 'k' });

  const store = await IndexStore.open(dir, { postings: false });
  assert.equal(store._shards, null, 'postings: false でも _shards が読み込まれている');

  const stats = store.stats();
  assert.equal(stats.chunks, 1, 'postings なしで stats() が動いていない');

  assert.throws(
    () => store.bm25(queryTerms('refundPayment'), 3),
    /postings.*未ロード|postings.*読み込/,
    'postings 未ロードで bm25 を呼んでも TypeError 以外の分かるエラーにならない'
  );

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

// ------------------------------------------------------------------ 埋め込み
test('埋め込み: クエリと文書で input_type を使い分ける', () => {
  const voyage = { provider: 'voyage', model: 'voyage-3-lite', dimensions: 512 };
  assert.equal(buildEmbeddingRequest(voyage, ['x']).body.input_type, 'document', '既定は文書側');
  assert.equal(buildEmbeddingRequest(voyage, ['x'], 'query').body.input_type, 'query');
  assert.equal(buildEmbeddingRequest(voyage, ['x']).url, 'https://api.voyageai.com/v1/embeddings');

  // OpenAI 系に input_type は存在しないので送らない
  const openai = { provider: 'openai', model: 'text-embedding-3-small', dimensions: 512 };
  assert.equal(buildEmbeddingRequest(openai, ['x'], 'query').body.input_type, undefined);
  assert.equal(buildEmbeddingRequest(openai, ['x']).body.dimensions, 512);

  // dimensions は openai のみ。compat 先（Ollama 等）には送らない
  const compat = { provider: 'openai-compat', model: 'nomic-embed-text', dimensions: 768, baseUrl: 'http://localhost:11434/v1/' };
  assert.equal(buildEmbeddingRequest(compat, ['x']).body.dimensions, undefined);
  assert.equal(buildEmbeddingRequest(compat, ['x']).url, 'http://localhost:11434/v1/embeddings', '末尾スラッシュが重複しない');
});

test('埋め込み: レスポンスを data[].index の順に並べ直す', () => {
  const shuffled = { data: [{ index: 2, embedding: [3] }, { index: 0, embedding: [1] }, { index: 1, embedding: [2] }] };
  assert.deepEqual(parseEmbeddingResponse(shuffled, 3), [[1], [2], [3]]);

  // index を返さないプロバイダではレスポンス順を保つ（sort の安定性）
  const noIndex = { data: [{ embedding: [1] }, { embedding: [2] }] };
  assert.deepEqual(parseEmbeddingResponse(noIndex, 2), [[1], [2]]);

  // 数が合わない応答を黙って受け入れるとチャンクとベクトルの対応がずれる
  assert.throws(() => parseEmbeddingResponse({ data: [{ index: 0, embedding: [1] }] }, 2), /応答数/);
  assert.throws(() => parseEmbeddingResponse({}, 1), /data 配列/);
});

test('埋め込み: 設定と違う次元数のベクトルを受け入れない', () => {
  const body = { data: [{ index: 0, embedding: [1, 2, 3] }] };
  assert.deepEqual(parseEmbeddingResponse(body, 1, 3), [[1, 2, 3]]);
  // vectors.bin は dims 固定ストライドなので、黙って通すと以降の読み出しが全部ずれる
  let caught;
  try { parseEmbeddingResponse(body, 1, 512); } catch (err) { caught = err; }
  assert.match(caught.message, /dimensions=512/);
  assert.equal(caught.noRetry, true, '設定ミスなのでリトライさせない');
});

test('埋め込み: キャッシュは provider まで含めて区別する', () => {
  const base = { provider: 'openai', model: 'text-embedding-3-small', dimensions: 512 };
  const compat = { ...base, provider: 'openai-compat' };
  // model 名と次元数が同じでも、別のサーバが返したベクトルを流用してはいけない
  assert.notEqual(embedCacheKey(base, 'chunk-hash'), embedCacheKey(compat, 'chunk-hash'));
  assert.notEqual(embedCacheNamespace(base), embedCacheNamespace(compat));
  assert.equal(embedCacheKey(base, 'chunk-hash'), embedCacheKey({ ...base }, 'chunk-hash'), '同じ設定なら同じキー');
  assert.notEqual(embedCacheKey(base, 'a'), embedCacheKey({ ...base, dimensions: 256 }, 'a'));
  assert.ok(!/[^\w.-]/.test(embedCacheNamespace(compat)), 'ディレクトリ名として安全な文字だけになる');
});

test('埋め込み: 途中で失敗しても成功分はキャッシュに残る', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-emb-'));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { input } = JSON.parse(body);
      requests.push(input);
      // 入力順と違う順で返す（index に従って戻せることの確認）
      const data = input.map((t, i) => ({ index: i, embedding: [t.length, 1, 0, 0] })).reverse();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  const cfg = { provider: 'openai-compat', model: 'test-embed', dimensions: 4, baseUrl, apiKeyEnv: 'TEST_EMBED_KEY', batch: 2 };
  initEgress({
    sources: [], llm: { provider: 'dry' }, retrieval: { embedding: cfg },
    security: { auditLog: false }, workspaceDir: dir,
  });
  const chunks = ['a', 'bb', 'ccc', 'dddd'].map((t, i) => ({ hash: `h${i}`, text: t }));
  const opts = { security: { allowEmbeddingUpload: true } };

  // 1 バッチ目の直後に認証情報を失わせて中断させる
  // （noRetry の失敗なのでバックオフ待ちなしに中断点を再現できる）
  process.env.TEST_EMBED_KEY = 'dummy';
  server.once('request', (req) => req.on('end', () => { delete process.env.TEST_EMBED_KEY; }));
  await assert.rejects(() => embedChunks(chunks, cfg, dir, opts), /TEST_EMBED_KEY/);
  assert.equal(requests.length, 1, '1 バッチだけ送られて中断していること');

  // 再実行: 成功していた 2 件はキャッシュから復元され、残り 2 件だけを取りにいく
  process.env.TEST_EMBED_KEY = 'dummy';
  const vectors = await embedChunks(chunks, cfg, dir, opts);
  assert.equal(requests.length, 2, '失敗前の分を再取得している（部分キャッシュが永続化されていない）');
  assert.deepEqual(requests[1], ['ccc', 'dddd']);

  assert.equal(vectors.length, 4);
  for (const [i, t] of ['a', 'bb', 'ccc', 'dddd'].entries()) {
    assert.equal(vectors[i].length, 4);
    // 正規化後も v[0]/v[1] は元の比（= 文字数）を保つ。順序がずれればここで落ちる
    assert.ok(Math.abs(vectors[i][0] / vectors[i][1] - t.length) < 1e-4, `${t} のベクトルが対応していない`);
  }

  delete process.env.TEST_EMBED_KEY;
  await new Promise((r) => server.close(r));
  await fsp.rm(dir, { recursive: true, force: true });
});
