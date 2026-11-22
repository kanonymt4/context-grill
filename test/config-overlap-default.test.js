import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { chunkDocument } from '../src/index/chunk.js';

import { loadConfig } from '../src/config.js';

// 利用者が overlap を書いていないとき、既定の overlap が max 以上になる設定（max だけ小さくした場合）を
// 読み込みエラーにしない。既定値を max 未満に丸める。明示した overlap >= max は従来どおりエラー。
// 一時ディレクトリに設定を置くので、リポジトリ直下の .env は読まれない。
const BASE = { llm: { provider: 'dry', model: 'd' }, sources: [{ id: 'w', type: 'local', path: '.' }] };

async function load(extra) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-overlap-'));
  try {
    const file = path.join(dir, 'context-grill.config.json');
    await fsp.writeFile(file, JSON.stringify({ ...BASE, ...extra }));
    return await loadConfig(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('overlap 既定の丸め: maxLines: 10 / doc.maxChars: 200 だけの設定が読み込め、既定の overlap が max の半分（切り捨て）になる', async () => {
  const c = await load({ retrieval: { chunk: { code: { maxLines: 10 }, doc: { maxChars: 200 } } } });
  assert.equal(c.retrieval.chunk.code.maxLines, 10);
  assert.equal(c.retrieval.chunk.code.overlapLines, 5);
  assert.equal(c.retrieval.chunk.doc.maxChars, 200);
  assert.equal(c.retrieval.chunk.doc.overlapChars, 100);
});

test('overlap 既定の丸め: max が 1 のときは 0（max / 2 を切り捨て）', async () => {
  const c = await load({ retrieval: { chunk: { code: { maxLines: 1 }, doc: { maxChars: 1 } } } });
  assert.equal(c.retrieval.chunk.code.overlapLines, 0);
  assert.equal(c.retrieval.chunk.doc.overlapChars, 0);
});

test('overlap 既定の丸め(対照): 既定のままの設定・max を変えても既定 overlap が収まる設定は既定値のまま', async () => {
  const d = await load({});
  assert.equal(d.retrieval.chunk.code.overlapLines, 12);
  assert.equal(d.retrieval.chunk.doc.overlapChars, 220);
  const c = await load({ retrieval: { chunk: { code: { maxLines: 50 }, doc: { maxChars: 1000 } } } });
  assert.equal(c.retrieval.chunk.code.overlapLines, 12);
  assert.equal(c.retrieval.chunk.doc.overlapChars, 220);
  // 片方だけ丸める（もう一方は既定のまま）
  const e = await load({ retrieval: { chunk: { code: { maxLines: 10 } } } });
  assert.equal(e.retrieval.chunk.code.overlapLines, 5);
  assert.equal(e.retrieval.chunk.doc.overlapChars, 220);
});

test('overlap 既定の丸め(対照): 利用者が明示した overlap >= max は従来どおり設定エラー', async () => {
  await assert.rejects(() => load({ retrieval: { chunk: { code: { maxLines: 10, overlapLines: 12 } } } }), /overlapLines は maxLines（10）未満で指定してください（現在: 12）/);
  await assert.rejects(() => load({ retrieval: { chunk: { doc: { maxChars: 200, overlapChars: 220 } } } }), /overlapChars は maxChars（200）未満/);
  await assert.rejects(() => load({ retrieval: { chunk: { code: { maxLines: 10, overlapLines: 10 } } } }), /overlapLines は maxLines/);
});

test('sources[].depth: 0 は読み込める（github.js は 0 を既定の 1 として扱う）。負の値は拒否', async () => {
  const c = await load({ sources: [{ id: 'w', type: 'github', repo: 'o/r', depth: 0 }] });
  assert.equal(c.sources[0].depth, 0);
  await assert.rejects(() => load({ sources: [{ id: 'w', type: 'github', repo: 'o/r', depth: -1 }] }), /sources\[0\]\.depth は 0 以上の数値/);
});

test('overlap 既定の丸め: overlap を null にした場合は書いていない扱い（deepMerge で既定値に戻るため丸める）', async () => {
  const c = await load({ retrieval: { chunk: { code: { maxLines: 10, overlapLines: null }, doc: { maxChars: 200, overlapChars: null } } } });
  assert.equal(c.retrieval.chunk.code.overlapLines, 5);
  assert.equal(c.retrieval.chunk.doc.overlapChars, 100);
});

test('overlap 既定の丸め(対照): 既定の overlap が max/2 以下なら既定値のまま（既定の 110/12・2200/220 は不変、max=24 の 12 も不変）', async () => {
  const c = await load({ retrieval: { chunk: { code: { maxLines: 24 }, doc: { maxChars: 440 } } } });
  assert.equal(c.retrieval.chunk.code.overlapLines, 12);
  assert.equal(c.retrieval.chunk.doc.overlapChars, 220);
  // max=23 は floor(23/2)=11 < 12 なので丸める
  const d = await load({ retrieval: { chunk: { code: { maxLines: 23 } } } });
  assert.equal(d.retrieval.chunk.code.overlapLines, 11);
});

test('overlap 既定の丸め: 丸めた設定で 1000 行のコードを分割しても、チャンク数は overlap 0 の約 2 倍以内（max-1 では爆発する）', async () => {
  const c = await load({ retrieval: { chunk: { code: { maxLines: 10 } } } });
  const text = Array.from({ length: 1000 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const doc = { id: 'd', sourceId: 's', kind: 'code', path: 'a.js', title: 'a.js', url: '', text };
  const count = (overlapLines) => chunkDocument(doc, { ...c.retrieval.chunk, code: { ...c.retrieval.chunk.code, overlapLines } }).length;
  const base = count(0);
  const rounded = count(c.retrieval.chunk.code.overlapLines);
  assert.ok(rounded <= base * 2, `丸めた設定のチャンク数 ${rounded} は overlap 0（${base}）の 2 倍以内のはず`);
  assert.ok(count(9) > base * 2, 'max-1 では 2 倍を超える（この閾値が意味を持つことの確認）');
});
