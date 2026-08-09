import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { syncSources, buildIndex } from '../src/index/ingest.js';
import { IndexStore } from '../src/index/store.js';
import { hybridSearch } from '../src/index/search.js';
import { runTask } from '../src/llm/pipeline.js';
import { bridgeTerms } from '../src/index/glossary.js';

async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'grounded-e2e-'));
  await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'src', 'payment.js'),
    'const MAX_RETRY = 3;\n\nasync function refundPayment(orderId) {\n  for (let i = 0; i < MAX_RETRY; i++) {\n    const res = await fetch(`https://psp.example.com/refund/${orderId}`, { method: "POST" });\n    if (res.ok) return res.json();\n  }\n  throw new Error("RefundFailed");\n}\nmodule.exports = { refundPayment, MAX_RETRY };\n');
  await fsp.writeFile(path.join(dir, 'docs', 'spec.md'),
    '# 決済仕様\n\n## 返金\n返金 API は最大 5 回までリトライする。\n');
  await fsp.writeFile(path.join(dir, 'grounded.config.json'), JSON.stringify({
    project: 'e2e',
    sources: [
      { id: 'repo', type: 'local', path: dir, include: ['src/**'] },
      { id: 'wiki', type: 'local', path: dir, include: ['docs/**'] },
    ],
    llm: { provider: 'dry', model: 'dry' },
  }));
  return dir;
}

test('用語辞書: 日本語クエリから英語識別子へ橋渡しする', () => {
  const b = bridgeTerms('返金のリトライ回数');
  assert.ok(b.has('refund'));
  assert.ok(b.has('retry'));
  const b2 = bridgeTerms('refundPayment retry policy');
  assert.ok(b2.has('返金') || b2.has('リトライ'));
});

test('E2E: sync → 索引 → 日本語クエリで英語コードに到達 → dry-run バンドル生成', async () => {
  const dir = await fixture();
  const config = await loadConfig(path.join(dir, 'grounded.config.json'));

  const report = await syncSources(config, {});
  assert.ok(report.every((r) => r.ok), JSON.stringify(report));
  const manifest = await buildIndex(config, { embed: false });
  assert.ok(manifest.N >= 2);

  const store = await IndexStore.open(path.join(dir, '.grounded', 'index'));
  const hits = await hybridSearch(store, { queries: ['返金のリトライ回数'], config, k: 5, kindPriors: {}, sourcePriority: {} });
  await store.close();
  const paths_ = hits.map((h) => h.path);
  assert.ok(paths_.includes('docs/spec.md'), '日本語文書がヒットする');
  assert.ok(paths_.includes('src/payment.js'), '用語辞書経由で英語コードにも到達する');

  const run = await runTask(config, { taskId: 'spec', instruction: '返金のリトライ仕様を整理して', effort: 'low', dryRun: true });
  assert.equal(run.dryRun, true);
  assert.ok(run.pack.items.length > 0);
  assert.ok(run.markdown.includes('<evidence id="E1"'));
  assert.ok(fs.existsSync(path.join(run.runDir, 'bundle.md')));
  assert.ok(fs.existsSync(path.join(run.runDir, 'evidence.json')));

  // 決定性: 同じ索引・同じ指示なら証拠パックは完全に同一
  const run2 = await runTask(config, { taskId: 'spec', instruction: '返金のリトライ仕様を整理して', effort: 'low', dryRun: true, save: false });
  assert.deepEqual(
    run.pack.items.map((e) => [e.id, e.path, e.start, e.end]),
    run2.pack.items.map((e) => [e.id, e.path, e.start, e.end]),
    '同一条件で証拠パックが再現されること'
  );
  await fsp.rm(dir, { recursive: true, force: true });
});
