import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import http from 'node:http';

import { loadConfig } from '../src/config.js';
import { syncSources, buildIndex } from '../src/index/ingest.js';
import { runTask } from '../src/llm/pipeline.js';
import { renderMarkdown } from '../src/report/render.js';

// dry-run の bundle.md が実際の送信内容と一致すること、
// および renderMarkdown が型の崩れた result で落ちず、未通過を表示すること

const KEY_ENV = 'CG_RENDER_BUNDLE_KEY';

/** 静的解析の検出が出る小さなプロジェクトを作り、索引まで作る */
async function makeProject() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-render-bundle-'));
  await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'src', 'app.js'), [
    'const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";',
    'function login(user, password) {',
    '  const sql = "SELECT * FROM users WHERE name = \'" + user + "\'";',
    '  return query(sql, password);',
    '}',
    'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";',
    '',
  ].join('\n'));
  await fsp.writeFile(path.join(dir, 'src', 'util.js'), 'export function retry(fn) { try { return fn(); } catch (e) { return retry(fn); } }\n');
  await fsp.writeFile(path.join(dir, 'README.md'), '# demo\n\nlogin の仕様と retry の方針\n');
  return dir;
}

async function configFor(dir, llm) {
  const file = path.join(dir, 'context-grill.config.json');
  await fsp.writeFile(file, JSON.stringify({
    project: 'rb',
    sources: [{ id: 'repo', type: 'local', path: dir, include: ['**/*'], includeUnknownTypes: true }],
    llm,
    retrieval: { embedding: { provider: 'none' } },
  }));
  const config = await loadConfig(file);
  await syncSources(config, {});
  await buildIndex(config, { embed: false });
  return config;
}

/** 受信した本文を記録し、最小の tool_use を返すダミー Anthropic サーバー */
async function startDummy() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        content: [{ type: 'tool_use', name: 'emit_report', input: { summary: 's', items: [], contradictions: [], open_questions: [], next_actions: [] } }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'tool_use',
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, bodies, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

/** bundle.md から、ユーザー側の本文（EVIDENCE と USER の囲みの中身）を取り出す */
function userSideOf(bundle) {
  const e0 = '# EVIDENCE\n\n```';
  const i0 = bundle.indexOf(e0);
  assert.ok(i0 >= 0, 'bundle に EVIDENCE の節があること');
  const evStart = bundle.indexOf('\n', i0 + e0.length) + 1;
  const sep = '\n```\n\n# USER\n\n```\n';
  const iSep = bundle.indexOf(sep, evStart);
  assert.ok(iSep >= 0, 'bundle に USER の節があること');
  const usStart = iSep + sep.length;
  const usEnd = bundle.indexOf('\n```\n\n# OUTPUT JSON SCHEMA', usStart);
  assert.ok(usEnd >= 0, 'bundle に OUTPUT JSON SCHEMA の節があること');
  return [bundle.slice(evStart, iSep), bundle.slice(usStart, usEnd)];
}

for (const taskId of ['static', 'security', 'bug']) {
  test(`bundle: ${taskId} の dry-run のユーザー側の本文が、実際に送信される本文と一致する`, async () => {
    const dir = await makeProject();
    const dummy = await startDummy();
    process.env[KEY_ENV] = 'dummy';
    try {
      const config = await configFor(dir, { provider: 'anthropic', model: 'm', apiKeyEnv: KEY_ENV, baseUrl: dummy.baseUrl });
      const ask = { taskId, instruction: 'login 周りの問題を調べて', effort: 'low', save: false };

      const dry = await runTask(config, { ...ask, dryRun: true });
      assert.equal(dry.dryRun, true);
      assert.equal(dummy.bodies.length, 0, '前提: dry-run は送信しない');
      assert.ok(dry.prompt.cacheableUser.includes('# 機械的解析の結果'), '前提: 静的解析の節が送信対象に含まれる');

      await runTask(config, ask);
      assert.ok(dummy.bodies.length >= 1, '前提: 本実行でダミーサーバーが受信する');
      const content = dummy.bodies[0].messages[0].content;
      const sent = content.map((b) => b.text);
      assert.equal(sent.length, 2, '前提: cacheableUser と user の 2 ブロック');

      const [head, tail] = userSideOf(dry.markdown);
      assert.equal(head, sent[0], 'bundle の EVIDENCE 部分が送信された cacheableUser と一致しない');
      assert.equal(tail, sent[1], 'bundle の USER 部分が送信された user と一致しない');
      assert.equal(`${head}\n\n${tail}`, sent.join('\n\n'), '結合した本文が一致しない');
    } finally {
      delete process.env[KEY_ENV];
      dummy.server.closeAllConnections?.();
      dummy.server.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------- 描画

function baseRun(overrides = {}) {
  return {
    task: { id: 'spec', label: '仕様整理' },
    instruction: '調べて',
    result: { summary: '要約', items: [], contradictions: [], open_questions: [], next_actions: [] },
    pack: { items: [], tokens: 0, droppedCount: 0 },
    verification: { ok: true, stats: { citedEvidence: 0, quotesChecked: 0, quotesFailed: 0, itemsAccepted: 0, itemsRejected: 0, hardViolations: 0 } },
    meta: {
      startedAt: 't', project: 'p', effort: 'low', provider: 'dry', model: 'm', promptHash: 'h',
      indexKey: 'abcdefabcdefabcdef', indexChunks: 1, queries: [], usage: { input: 0, output: 0, cacheRead: 0 }, repairs: 0,
    },
    staticSummary: { total: 0, bySeverity: {}, byRule: {} },
    ...overrides,
  };
}

test('描画: open_questions / contradictions / next_actions が配列でなくても落ちず、undefined を出さない', () => {
  const run = baseRun({
    result: { summary: '要約', items: [], open_questions: 'あいうえお', contradictions: {}, next_actions: 'x' },
  });
  let md;
  assert.doesNotThrow(() => { md = renderMarkdown(run); });
  assert.ok(!md.includes('undefined'), md);
  assert.ok(md.includes('- なし'), '未解決の論点は「なし」になる');
});

test('描画: items が配列でない、要素がオブジェクトでない場合も落ちず、undefined を出さない', () => {
  const run = baseRun({
    result: {
      summary: '要約', items: 'abc',
      contradictions: [null, 'x', 3, []], open_questions: [null, 'q', 7], next_actions: [null, 'a'],
    },
  });
  let md;
  assert.doesNotThrow(() => { md = renderMarkdown(run); });
  assert.ok(!md.includes('undefined'), md);
  const run2 = baseRun({ result: { summary: '要約', items: [null, 'x', 5] } });
  assert.doesNotThrow(() => { md = renderMarkdown(run2); });
  assert.ok(!md.includes('undefined'), md);
});

test('描画: 要素の evidence / quotes が配列でなくても落ちない', () => {
  const run = baseRun({
    result: {
      summary: '要約',
      items: [{ id: 'I1', type: 'spec', title: 't', statement: 's', confidence: 'high', evidence: 'E1', quotes: 'abc', contradicting_evidence: 'E2' }],
      contradictions: [{ description: 'd', evidence: 'E1' }],
      next_actions: [{ action: 'a', evidence: 'E1' }],
    },
  });
  assert.doesNotThrow(() => renderMarkdown(run));
});

test('描画: 検証が未通過なら冒頭に警告行（違反件数つき）を出し、通過なら出さない', () => {
  const ng = baseRun({ verification: { ok: false, stats: { citedEvidence: 0, quotesChecked: 0, quotesFailed: 0, itemsAccepted: 0, itemsRejected: 0, hardViolations: 3 } } });
  const md = renderMarkdown(ng);
  const line = '> ⚠ 機械検証は通過していません（違反 3 件）。以下の主張は一部が除去されている可能性があります。';
  assert.ok(md.split('\n').includes(line), md);
  assert.ok(md.indexOf(line) < md.indexOf('## 要約'), '警告は要約より前');

  const ok = renderMarkdown(baseRun());
  assert.ok(!ok.includes('機械検証は通過していません'), '通過したときは何も足さない');
});
