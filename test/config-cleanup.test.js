import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, DEFAULTS } from '../src/config.js';

// 設定の秘密値スキャンの対象（名前の集合と走査範囲）と、効かない設定キーの整理。
// 一時ディレクトリに設定を置くので、リポジトリ直下の .env は読まれない。外部通信は起こさない。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = { llm: { provider: 'dry', model: 'd' }, sources: [{ id: 'w', type: 'local', path: '.' }] };
const SECRET = 'cg-test-secret-value-0123456789';

async function withEnv(vars, fn) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k];
  }
}

async function load(extra, { raw } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-cleanup-'));
  try {
    const file = path.join(dir, 'context-grill.config.json');
    await fsp.writeFile(file, raw ?? JSON.stringify({ ...BASE, ...extra }));
    return await loadConfig(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function rejectsSecret(extra, name, where) {
  await assert.rejects(() => load(extra), (e) => {
    assert.match(e.message, new RegExp(`環境変数 ${name} の値が展開`), `実際: ${e.message}`);
    if (where) assert.ok(e.message.includes(where), `${where} が無い。実際: ${e.message}`);
    assert.ok(!e.message.includes(SECRET), '秘密値がエラーに出ている');
    return true;
  });
}

// ---------------------------------------------------------------- 秘密値スキャンの名前
test('cleanup: 名前に BEARER を含む環境変数の値が baseUrl に展開されたら拒否する', async () => {
  await withEnv({ CG_T_BEARER: SECRET }, async () => {
    await rejectsSecret({
      sources: [{ id: 'w', type: 'confluence', baseUrl: 'https://x.example.com/${CG_T_BEARER}' }],
    }, 'CG_T_BEARER', 'sources[0].baseUrl');
  });
});

test('cleanup: project への BEARER 名の展開も拒否する', async () => {
  await withEnv({ CG_T_BEARER_X: SECRET }, async () => {
    await rejectsSecret({ project: 'p-${CG_T_BEARER_X}' }, 'CG_T_BEARER_X', 'project');
  });
});

// ---------------------------------------------------------------- 秘密値スキャンの走査範囲
test('cleanup: project / workspace / budget / policy / effortPresets / 未知のキーの文字列に展開された秘密値を拒否する', async () => {
  await withEnv({ CG_T_TOKEN_X: SECRET }, async () => {
    await rejectsSecret({ project: 'p-${CG_T_TOKEN_X}' }, 'CG_T_TOKEN_X', 'project');
    await rejectsSecret({ workspace: 'ws-${CG_T_TOKEN_X}' }, 'CG_T_TOKEN_X', 'workspace');
    await rejectsSecret({ budget: { note: '${CG_T_TOKEN_X}' } }, 'CG_T_TOKEN_X', 'budget.note');
    await rejectsSecret({ policy: { note: '${CG_T_TOKEN_X}' } }, 'CG_T_TOKEN_X', 'policy.note');
    await rejectsSecret({ effortPresets: { normal: { note: '${CG_T_TOKEN_X}' } } }, 'CG_T_TOKEN_X', 'effortPresets.normal.note');
    await rejectsSecret({ extra: { deep: ['${CG_T_TOKEN_X}'] } }, 'CG_T_TOKEN_X', 'extra.deep[0]');
  });
});

test('cleanup: 回帰ガード: 秘密でない名前の展開は通り、値が config に入る', async () => {
  await withEnv({ CG_T_HOST: SECRET }, async () => {
    const c = await load({ project: 'p-${CG_T_HOST}', budget: { note: '${CG_T_HOST}' } });
    assert.equal(c.project, `p-${SECRET}`);
    assert.equal(c.budget.note, SECRET);
  });
});

test('cleanup: 回帰ガード: 12 文字未満の値や、秘密の値を含まない文字列は拒否しない', async () => {
  await withEnv({ CG_T_TOKEN_SHORT: 'short-val' }, async () => {
    const c = await load({ project: 'p-${CG_T_TOKEN_SHORT}' });
    assert.equal(c.project, 'p-short-val');
  });
  await withEnv({ CG_T_TOKEN_Y: SECRET }, async () => {
    const c = await load({ project: 'plain', budget: { note: 'other' } });
    assert.equal(c.project, 'plain');
  });
});

test('cleanup: 回帰ガード: presets の instruction の ${...} は展開されず、拒否もされない', async () => {
  await withEnv({ CG_T_TOKEN_Z: SECRET }, async () => {
    const c = await load({
      presets: [{ name: 'p1', task: 'spec', instruction: '${CG_T_TOKEN_Z} と ${CG_T_UNDEFINED_NAME} を文字のまま通す' }],
    });
    assert.equal(c.presets[0].instruction, '${CG_T_TOKEN_Z} と ${CG_T_UNDEFINED_NAME} を文字のまま通す');
  });
});

test('cleanup: 回帰ガード: 設定例と init が生成する設定は loadConfig を通る', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-cleanup-'));
  try {
    await fsp.copyFile(path.join(ROOT, 'context-grill.config.example.json'), path.join(dir, 'context-grill.config.json'));
    await loadConfig(path.join(dir, 'context-grill.config.json'));
    const dir2 = path.join(dir, 'init');
    await fsp.mkdir(dir2);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'context-grill.js'), 'init', '--dir', dir2],
      { cwd: dir2, encoding: 'utf8', env: { ...process.env } });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    await loadConfig(path.join(dir2, 'context-grill.config.json'));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 効かない設定キーの整理
const REMOVED = [
  ['retrieval.hybrid.bm25Top', (d) => d.retrieval?.hybrid ?? {}, 'bm25Top'],
  ['retrieval.hybrid.vectorTop', (d) => d.retrieval?.hybrid ?? {}, 'vectorTop'],
  ['retrieval.boosts.titleMatch', (d) => d.retrieval?.boosts ?? {}, 'titleMatch'],
  ['llm.plannerModel', (d) => d.llm ?? {}, 'plannerModel'],
  ['language', (d) => d, 'language'],
  ['policy.language', (d) => d.policy ?? {}, 'language'],
];

test('cleanup: 使われていないキーは DEFAULTS に無い', () => {
  for (const [label, pick, key] of REMOVED) {
    assert.ok(!Object.hasOwn(pick(DEFAULTS), key), `${label} が DEFAULTS に残っている`);
  }
});

test('cleanup: 使われていないキーは設定例に無い', async () => {
  const example = JSON.parse(await fsp.readFile(path.join(ROOT, 'context-grill.config.example.json'), 'utf8'));
  for (const [label, pick, key] of REMOVED) {
    assert.ok(!Object.hasOwn(pick(example), key), `${label} が設定例に残っている`);
  }
});

test('cleanup: 回帰ガード: 設定ファイルに古いキーが残っていても loadConfig は通る', async () => {
  const c = await load({
    language: 'ja',
    policy: { language: 'ja' },
    llm: { provider: 'dry', model: 'd', plannerModel: 'x' },
    retrieval: { hybrid: { bm25Top: 1, vectorTop: 2 }, boosts: { titleMatch: 0.1 } },
    sources: [{ id: 'w', type: 'local', path: '.', titleGlobs: 'a', spaceKeys: ['E'] }],
  });
  assert.equal(c.language, 'ja');
  assert.equal(c.retrieval.hybrid.bm25Top, 1);
});
