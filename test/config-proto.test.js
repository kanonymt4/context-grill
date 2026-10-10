import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { loadConfig } from '../src/config.js';
import { validatePresets } from '../src/presets.js';

// JSON.stringify({ __proto__: ... }) は {} になってしまい何も試せない。
// このテストでは設定を必ず生の JSON 文字列で書き、"__proto__" が実際にファイルへ
// 入っていることを確かめてから読み込む。
const BASE_SOURCE = '"id":"w","type":"confluence","baseUrl":"https://example.invalid/wiki"';
const LLM = '"llm":{"provider":"dry","model":"d"}';

async function withConfig(text, fn, { mustContainProto = true } = {}) {
  if (mustContainProto) assert.ok(text.includes('"__proto__"'), '前提: 設定の生の JSON に "__proto__" が含まれる');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-proto-'));
  try {
    const file = path.join(dir, 'context-grill.config.json');
    await fsp.writeFile(file, text);
    assert.equal(mustContainProto, (await fsp.readFile(file, 'utf8')).includes('"__proto__"'));
    return await fn(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function withEnv(name, value, fn) {
  const before = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

const rejectsWith = (file, ...patterns) => assert.rejects(
  () => loadConfig(file),
  (e) => {
    assert.match(e.message, /^設定エラー:/);
    for (const p of patterns) assert.match(e.message, p);
    return true;
  },
);

test('__proto__: 最上位の __proto__ は黙って消さずに拒否する', async () => {
  const text = `{"project":"x","sources":[{${BASE_SOURCE}}],${LLM},"__proto__":{"security":{"allowLlmUpload":false}}}`;
  await withConfig(text, (file) => rejectsWith(file, /__proto__/));
});

test('__proto__: 入れ子（llm / security）の __proto__ も拒否し、パスを示す', async () => {
  const llm = `{"project":"x","sources":[{${BASE_SOURCE}}],"llm":{"provider":"dry","model":"d","__proto__":{"model":"e"}}}`;
  await withConfig(llm, (file) => rejectsWith(file, /llm\.__proto__/));
  const sec = `{"project":"x","sources":[{${BASE_SOURCE}}],${LLM},"security":{"__proto__":{"allowLlmUpload":false}}}`;
  await withConfig(sec, (file) => rejectsWith(file, /security\.__proto__/));
});

test('__proto__: 配列の要素（sources[0]）の中の __proto__ も拒否する', async () => {
  const text = `{"project":"x","sources":[{${BASE_SOURCE},"__proto__":{"baseUrl":"https://example.invalid/other"}}],${LLM}}`;
  await withConfig(text, (file) => rejectsWith(file, /sources\[0\]\.__proto__/));
});

test('__proto__: sources[0].__proto__ 経由で秘密値を通して秘密値スキャンを迂回できない', async () => {
  await withEnv('CG_X_TOKEN', 'proto-bypass-secret-value-123', async () => {
    const text = `{"project":"x","sources":[{"id":"w","type":"confluence","__proto__":{"baseUrl":"https://example.invalid/\${CG_X_TOKEN}"}}],${LLM}}`;
    await withConfig(text, (file) => rejectsWith(file, /sources\[0\]\.__proto__/));
  });
});

test('__proto__: own のキーに秘密値を書いた場合は従来どおり秘密値として拒否する（回帰ガード）', async () => {
  await withEnv('CG_X_TOKEN', 'proto-bypass-secret-value-123', async () => {
    const text = `{"project":"x","sources":[{"id":"w","type":"confluence","baseUrl":"https://example.invalid/\${CG_X_TOKEN}"}],${LLM}}`;
    await withConfig(text, (file) => rejectsWith(file, /CG_X_TOKEN の値が展開/), { mustContainProto: false });
  });
});

test('__proto__: 複数箇所にあれば全部列挙する', async () => {
  const text = `{"project":"x","sources":[{${BASE_SOURCE},"__proto__":{}}],"llm":{"provider":"dry","model":"d","__proto__":{}},"__proto__":{}}`;
  await withConfig(text, (file) => rejectsWith(file, /sources\[0\]\.__proto__/, /llm\.__proto__/, /(^|\s)__proto__(\s|$)/));
});

test('__proto__: presets の配下は loadConfig では拒否せず、validatePresets が報告する', async () => {
  const text = `{"project":"x","sources":[{${BASE_SOURCE}}],${LLM},"presets":[`
    + '{"name":"a","task":"spec","instruction":"x","__proto__":{}},'
    + '{"name":"b","task":"spec","instruction":"x","arguments":[{"name":"p","__proto__":{}}]}]}';
  await withConfig(text, async (file) => {
    const config = await loadConfig(file);
    const errs = validatePresets(config);
    assert.ok(errs.some((m) => m.includes('__proto__')), `validatePresets が __proto__ を報告する: ${JSON.stringify(errs)}`);
  });
});

test('__proto__: presets 以外に無い正常な設定と _comment は従来どおり読める', async () => {
  const text = `{"_comment":"メモ","project":"x","sources":[{${BASE_SOURCE},"_comment":"メモ"}],${LLM}}`;
  await withConfig(text, async (file) => {
    const config = await loadConfig(file);
    assert.equal(config.project, 'x');
    assert.equal(config.sources[0].id, 'w');
  }, { mustContainProto: false });
});
