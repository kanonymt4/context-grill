import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { syncSources, buildIndex } from '../src/index/ingest.js';
import { runTask } from '../src/llm/pipeline.js';
import {
  PresetError, parseTemplate, validatePresets, listPresets, getPreset, resolvePreset,
} from '../src/presets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'context-grill.js');

// ---------------------------------------------------------------- 共通準備
const SOURCES = [
  { id: 'api', type: 'local', path: 'api', include: ['**/*'], includeUnknownTypes: true },
  { id: 'web', type: 'local', path: 'web', include: ['**/*'], includeUnknownTypes: true },
];

/** 設定オブジェクトを書いた一時ディレクトリを作る。raw を渡すと JSON 文字列をそのまま書く */
async function makeDir({ presets, raw, overrides = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-preset-'));
  await fsp.mkdir(path.join(dir, 'api'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'web'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'api', 'handler.js'), 'export function handler() { /* timeout retry */ return "api-timeout-retry"; }\n');
  await fsp.writeFile(path.join(dir, 'web', 'page.js'), 'export function page() { /* timeout retry */ return "web-timeout-retry"; }\n');
  const file = path.join(dir, 'context-grill.config.json');
  if (raw !== undefined) {
    await fsp.writeFile(file, raw);
  } else {
    const body = { project: 'x', sources: SOURCES, llm: { provider: 'dry', model: 'd' }, ...overrides };
    if (presets !== undefined) body.presets = presets;
    await fsp.writeFile(file, JSON.stringify(body));
  }
  return { dir, file };
}

/** 設定を読み込んで一時ディレクトリを消す（形の検証だけなら実体は不要） */
async function cfgOf(presets, overrides = {}) {
  const { dir, file } = await makeDir({ presets, overrides });
  try {
    return await loadConfig(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function errsOf(presets, overrides = {}) {
  return validatePresets(await cfgOf(presets, overrides));
}

/** 正常な preset の雛形 */
const P = (over = {}) => ({ name: 'p', task: 'bug', instruction: '調べる', ...over });
const ARG = (over = {}) => ({ name: 'focus', ...over });

const hit = (errs, re) => errs.some((e) => re.test(e));

const BUG_TRIAGE = {
  name: 'bug-triage',
  description: '不具合の切り分け',
  task: 'bug',
  effort: 'deep',
  sources: ['api', 'web'],
  instruction: '症状: {{symptom}} / 対象: {{component}}',
  arguments: [
    { name: 'symptom', description: '症状' },
    { name: 'component', required: false, default: '全体' },
  ],
};
const PLAIN = { name: 'plain', task: 'spec', instruction: 'API 仕様を整理する' };
const LIT = {
  name: 'lit',
  task: 'spec',
  instruction: '\\{{literal}} と }} と {{x}}',
  arguments: [{ name: 'x' }],
};
const OPT_ONLY = {
  name: 'opt-only',
  task: 'spec',
  instruction: '{{opt}}',
  arguments: [{ name: 'opt', required: false, default: '' }],
};

let sharedConfig;
async function shared() {
  if (!sharedConfig) sharedConfig = await cfgOf([BUG_TRIAGE, PLAIN, LIT, OPT_ONLY]);
  return sharedConfig;
}

const isPresetError = (code) => (e) => e instanceof PresetError && e.code === code;

// ============================================================ A. 設定と検証
test('A1: presets を省略すると config.presets は [] で、検証エラーも無い', async () => {
  const config = await cfgOf(undefined);
  assert.deepEqual(config.presets, []);
  assert.deepEqual(validatePresets(config), []);
});

test('A2: 正常な preset は検証を通り、listPresets が既定値を補って定義順に返す', async () => {
  const config = await cfgOf([BUG_TRIAGE, PLAIN]);
  assert.deepEqual(validatePresets(config), []);
  const list = listPresets(config);
  assert.deepEqual(list.map((p) => p.name), ['bug-triage', 'plain']);
  assert.equal(list[1].effort, 'normal');
  assert.equal(list[1].sources, null);
  assert.equal(list[1].description, null);
  assert.deepEqual(list[1].arguments, []);
  assert.deepEqual(list[0].sources, ['api', 'web']);
  assert.deepEqual(list[0].arguments, [
    { name: 'symptom', description: '症状', required: true, default: null },
    { name: 'component', description: null, required: false, default: '全体' },
  ]);
  // 返り値は複製で、書き換えても設定に影響しない
  list[0].sources.push('zzz');
  assert.deepEqual(config.presets[0].sources, ['api', 'web']);
});

test('A3: presets をオブジェクト形式で書いても loadConfig は成功し、検証が配列で書くよう案内する', async () => {
  const config = await cfgOf({ 'bug-triage': { task: 'bug', instruction: 'x' } });
  const errs = validatePresets(config);
  assert.ok(hit(errs, /presets は配列/), errs.join('\n'));
  assert.deepEqual(listPresets(config), []);
});

test('A4: model / modelOverride / llm / provider は preset に持たせられない', async () => {
  for (const key of ['model', 'modelOverride', 'llm', 'provider']) {
    const errs = await errsOf([P({ [key]: 'x' })]);
    assert.ok(hit(errs, new RegExp(`${key} は指定できません`)), `${key}: ${errs.join('\n')}`);
    assert.ok(hit(errs, /llm\.model/), `${key}: llm.model への案内が無い`);
  }
});

test('A5: source（単数）と綴り違いは拒否し、_comment は通す', async () => {
  const single = await errsOf([P({ source: 'api' })]);
  assert.ok(hit(single, /source.*sources/), single.join('\n'));
  const typo = await errsOf([P({ sorce: ['api'] })]);
  assert.ok(hit(typo, /sorce/), typo.join('\n'));
  const dry = await errsOf([P({ dryRun: true })]);
  assert.ok(hit(dry, /dryRun/), dry.join('\n'));
  assert.deepEqual(await errsOf([P({ _comment: 'メモ' })]), []);
});

test('A6: task は必須で、TASKS の自前キーだけを許す（constructor / toString を通さない）', async () => {
  for (const task of [undefined, 'bugs', 'constructor', 'toString', '__proto__', 1]) {
    const p = P();
    if (task === undefined) delete p.task; else p.task = task;
    const errs = await errsOf([p]);
    assert.ok(hit(errs, /task/), `task=${String(task)}: ${errs.join('\n')}`);
  }
  assert.deepEqual(await errsOf([P({ task: 'bug' })]), []);
});

test('A7: effort は effortPresets の自前キーだけを許し、一覧をハードコードしない', async () => {
  for (const effort of ['max', 'constructor']) {
    const errs = await errsOf([P({ effort })]);
    assert.ok(hit(errs, /effort/), `effort=${effort}: ${errs.join('\n')}`);
  }
  const overrides = { effortPresets: { huge: { queries: 2, final: 5, evidenceTokens: 1000 } } };
  assert.deepEqual(await errsOf([P({ effort: 'huge' })], overrides), []);
  assert.deepEqual(await errsOf([P({ effort: 'deep' })]), []);
});

test('A8: sources は config.sources の id だけを許す配列', async () => {
  const unknown = await errsOf([P({ sources: ['nope'] })]);
  assert.ok(hit(unknown, /nope/) && hit(unknown, /api, web/), unknown.join('\n'));
  for (const [label, sources] of [['空配列', []], ['重複', ['api', 'api']], ['非文字列', [1]]]) {
    const errs = await errsOf([P({ sources })]);
    assert.ok(hit(errs, /sources/), `${label}: ${errs.join('\n')}`);
  }
  const comma = await errsOf([P({ sources: 'api,web' })]);
  assert.ok(hit(comma, /sources/) && hit(comma, /配列/), comma.join('\n'));
  const config = await cfgOf([P({ sources: 'api' })]);
  assert.deepEqual(validatePresets(config), []);
  assert.deepEqual(resolvePreset(config, 'p').sourceIds, ['api']);
});

test('A9: name の形式と重複', async () => {
  const cases = [
    ['欠落', undefined], ['空', ''], ['先頭 -', '-x'], ['空白と大文字', 'Bad Name'],
    ['__proto__', '__proto__'], ['65 文字', 'a'.repeat(65)], ['非文字列', 1],
  ];
  for (const [label, name] of cases) {
    const p = P();
    if (name === undefined) delete p.name; else p.name = name;
    const errs = await errsOf([p]);
    assert.ok(hit(errs, /name/), `${label}: ${errs.join('\n')}`);
  }
  assert.deepEqual(await errsOf([P({ name: 'a'.repeat(64) })]), []);
  const dup = await errsOf([P({ name: 'same' }), P({ name: 'same' })]);
  assert.ok(dup.some((e) => /presets\[0\]/.test(e) && /presets\[1\]/.test(e)), dup.join('\n'));
});

test('A10: instruction は空でない文字列', async () => {
  for (const instruction of [undefined, '', '   ', 3]) {
    const p = P();
    if (instruction === undefined) delete p.instruction; else p.instruction = instruction;
    const errs = await errsOf([p]);
    assert.ok(hit(errs, /instruction/), `instruction=${String(instruction)}: ${errs.join('\n')}`);
  }
});

test('A11: プレースホルダの形式と宣言の対応', async () => {
  const declared = [ARG()];
  const bad = [
    ['未宣言', P({ instruction: '{{focus}}' })],
    ['宣言したが未使用', P({ instruction: 'x', arguments: declared })],
    ['空白入り', P({ instruction: '{{ focus }}', arguments: declared })],
    ['大文字', P({ instruction: '{{Focus}}', arguments: declared })],
    ['空', P({ instruction: 'a {{}} b' })],
    ['閉じていない', P({ instruction: '{{focus', arguments: declared })],
    ['三重', P({ instruction: '{{{focus}}}', arguments: declared })],
  ];
  for (const [label, preset] of bad) {
    const errs = await errsOf([preset]);
    assert.ok(errs.length > 0 && hit(errs, /presets\[0\]/), `${label}: 拒否されていない`);
  }
  assert.deepEqual(await errsOf([P({ instruction: '\\{{x}} と }}' })]), []);
  assert.deepEqual(await errsOf([P({ instruction: '{{focus}}', arguments: declared })]), []);
});

test('A12: arguments の形式', async () => {
  const bad = [
    ['配列でない', P({ instruction: 'x', arguments: { focus: {} } })],
    ['name 欠落', P({ arguments: [{}] })],
    ['name が数字始まり', P({ arguments: [{ name: '1x' }] })],
    ['name が __proto__', P({ arguments: [{ name: '__proto__' }] })],
    ['重複', P({ instruction: '{{a}}', arguments: [{ name: 'a' }, { name: 'a' }] })],
    ['required と default の併記', P({ instruction: '{{a}}', arguments: [{ name: 'a', required: true, default: 'd' }] })],
    ['required 省略と default の併記', P({ instruction: '{{a}}', arguments: [{ name: 'a', default: 'd' }] })],
    ['任意なのに default が無い', P({ instruction: '{{a}}', arguments: [{ name: 'a', required: false }] })],
    ['default が数値', P({ instruction: '{{a}}', arguments: [{ name: 'a', required: false, default: 3 }] })],
    ['未知キー', P({ instruction: '{{a}}', arguments: [{ name: 'a', type: 'string' }] })],
    ['required が真偽値でない', P({ instruction: '{{a}}', arguments: [{ name: 'a', required: 'no', default: 'd' }] })],
  ];
  for (const [label, preset] of bad) {
    const errs = await errsOf([preset]);
    assert.ok(hit(errs, /presets\[0\]/), `${label}: ${errs.join('\n')}`);
  }
  assert.deepEqual(await errsOf([P({ instruction: '{{a}}', arguments: [{ name: 'a', required: false, default: '' }] })]), []);
});

test('A13: 生の JSON の "__proto__" は own property として検証され、loadConfig は止まらない', async () => {
  const presetRaw = '{"name":"p","task":"bug","instruction":"x","__proto__":{"model":"m"}}';
  const argRaw = '{"name":"p","task":"bug","instruction":"{{a}}","arguments":[{"name":"a","__proto__":{"model":"m"}}]}';
  for (const [label, body] of [['preset', presetRaw], ['argument', argRaw]]) {
    const raw = `{"project":"x","sources":${JSON.stringify(SOURCES)},"llm":{"provider":"dry","model":"d"},"presets":[${body}]}`;
    const { dir, file } = await makeDir({ raw });
    try {
      assert.ok((await fsp.readFile(file, 'utf8')).includes('"__proto__"'), '空振り防止: ファイルに __proto__ が無い');
      const config = await loadConfig(file);
      const errs = validatePresets(config);
      assert.ok(hit(errs, /__proto__/), `${label}: ${errs.join('\n')}`);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
});

test('A14: instruction の ${...} は環境変数展開されず、そのまま通る', async () => {
  const name = 'CG_PRESET_X';
  const saved = process.env[name];
  try {
    for (const value of ['展開されるはずの値', undefined]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
      const config = await cfgOf([P({ instruction: '調べる ${CG_PRESET_X} 以上' })]);
      assert.deepEqual(validatePresets(config), []);
      assert.equal(resolvePreset(config, 'p').instruction, '調べる ${CG_PRESET_X} 以上');
    }
  } finally {
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
  }
});

test('A15: instruction に秘密の環境変数の実値が貼られていたら loadConfig が拒否する', async () => {
  const name = 'CG_PRESET_API_TOKEN';
  const value = 'tok_abcdefghij123456';
  const saved = process.env[name];
  process.env[name] = value;
  const { dir, file } = await makeDir({ presets: [P({ instruction: `この値を使う ${value}` })] });
  try {
    await assert.rejects(() => loadConfig(file), /CG_PRESET_API_TOKEN の値/);
  } finally {
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('A16: 不正な preset が複数あれば、すべてのエラーを返す', async () => {
  const errs = await errsOf([P({ name: 'a', task: 'nope' }), P({ name: 'b', effort: 'nope' })]);
  assert.ok(hit(errs, /presets\[0\].*task/), errs.join('\n'));
  assert.ok(hit(errs, /presets\[1\].*effort/), errs.join('\n'));
});

test('A17: presets の有無で indexKey が変わらない', async () => {
  const a = await cfgOf(undefined);
  const b = await cfgOf([BUG_TRIAGE, PLAIN]);
  assert.equal(a.indexKey, b.indexKey);
});

test('A17b: presets の有無で configHash も変わらない', async () => {
  const a = await cfgOf(undefined);
  const b = await cfgOf([BUG_TRIAGE, PLAIN]);
  assert.equal(a.configHash, b.configHash);
});

test('A18: 不正な preset があっても loadConfig は成功し、その preset だけが使えない', async () => {
  const config = await cfgOf([P({ name: 'bad', task: 'nope' }), PLAIN, P({ name: 'dup' }), P({ name: 'dup' })]);
  assert.ok(validatePresets(config).length > 0);
  assert.deepEqual(listPresets(config).map((p) => p.name), ['plain']);
  assert.throws(() => getPreset(config, 'bad'), isPresetError('EPRESET_INVALID'));
  assert.throws(() => resolvePreset(config, 'bad'), isPresetError('EPRESET_INVALID'));
  assert.throws(() => getPreset(config, 'dup'), isPresetError('EPRESET_INVALID'));
  // メッセージにはその preset のエラーだけが入る
  assert.throws(() => getPreset(config, 'bad'), (e) => /task/.test(e.message) && !/dup/.test(e.message));
  assert.equal(getPreset(config, 'plain').name, 'plain');
  assert.equal(resolvePreset(config, 'plain').taskId, 'spec');
});

test('parseTemplate: プレースホルダを部品に分け、不正な {{ を errors に積む', () => {
  const ok = parseTemplate('a{{x}}b');
  assert.deepEqual(ok.parts, ['a', { arg: 'x' }, 'b']);
  assert.deepEqual(ok.names, ['x']);
  assert.deepEqual(ok.errors, []);
  assert.ok(parseTemplate('{{ x }}').errors.length > 0);
  assert.ok(parseTemplate('{{}}').errors.length > 0);
  assert.deepEqual(parseTemplate('\\{{x}}').errors, []);
});

// ============================================================ B. resolvePreset
test('B1: 正常に解決し、戻り値のキーは 4 つだけ', async () => {
  const config = await shared();
  const r = resolvePreset(config, 'bug-triage', { symptom: '500 エラー', component: 'api' });
  assert.deepEqual(Object.keys(r).sort(), ['effort', 'instruction', 'sourceIds', 'taskId']);
  assert.equal(r.taskId, 'bug');
  assert.equal(r.effort, 'deep');
  assert.deepEqual(r.sourceIds, ['api', 'web']);
  assert.equal(r.instruction, '症状: 500 エラー / 対象: api');
});

test('B2: 任意引数は省略・空・空白のとき default を使う', async () => {
  const config = await shared();
  for (const args of [{ symptom: 's' }, { symptom: 's', component: '' }, { symptom: 's', component: '  ' }]) {
    assert.equal(resolvePreset(config, 'bug-triage', args).instruction, '症状: s / 対象: 全体');
  }
});

test('B3: 必須引数が無ければ ARG_MISSING', async () => {
  const config = await shared();
  assert.throws(() => resolvePreset(config, 'bug-triage', {}), (e) =>
    isPresetError('EPRESET_ARGS')(e) && e.issues.some((i) => i.code === 'ARG_MISSING' && i.arg === 'symptom'));
});

test('B4: 必須引数が空・空白のみなら ARG_EMPTY', async () => {
  const config = await shared();
  for (const symptom of ['', '  ']) {
    assert.throws(() => resolvePreset(config, 'bug-triage', { symptom }), (e) =>
      isPresetError('EPRESET_ARGS')(e) && e.issues.some((i) => i.code === 'ARG_EMPTY' && i.arg === 'symptom'));
  }
});

test('B5: 未宣言の引数は ARG_UNKNOWN で、宣言済みの一覧をメッセージに含める', async () => {
  const config = await shared();
  assert.throws(() => resolvePreset(config, 'bug-triage', { symptom: 's', sympton: 'typo' }), (e) =>
    isPresetError('EPRESET_ARGS')(e)
    && e.issues.some((i) => i.code === 'ARG_UNKNOWN' && i.arg === 'sympton')
    && /symptom/.test(e.message) && /component/.test(e.message));
  assert.throws(() => resolvePreset(config, 'plain', { x: '1' }), (e) =>
    isPresetError('EPRESET_ARGS')(e) && e.issues.some((i) => i.code === 'ARG_UNKNOWN' && i.arg === 'x'));
});

test('B6: 文字列でない値は ARG_TYPE', async () => {
  const config = await shared();
  for (const symptom of [3, null, []]) {
    assert.throws(() => resolvePreset(config, 'bug-triage', { symptom }), (e) =>
      isPresetError('EPRESET_ARGS')(e) && e.issues.some((i) => i.code === 'ARG_TYPE' && i.arg === 'symptom'));
  }
});

test('B7: プロトタイプから値を読まない（__proto__ / constructor）', async () => {
  const config = await shared();
  const args = JSON.parse('{"__proto__":{"symptom":"x"}}');
  assert.throws(() => resolvePreset(config, 'bug-triage', args), (e) =>
    isPresetError('EPRESET_ARGS')(e)
    && e.issues.some((i) => i.code === 'ARG_UNKNOWN' && i.arg === '__proto__')
    && e.issues.some((i) => i.code === 'ARG_MISSING' && i.arg === 'symptom'));
  assert.throws(() => resolvePreset(config, 'bug-triage', { symptom: 's', constructor: 'x' }), (e) =>
    isPresetError('EPRESET_ARGS')(e) && e.issues.some((i) => i.code === 'ARG_UNKNOWN' && i.arg === 'constructor'));
});

test('B8: 未知の preset 名は EPRESET_UNKNOWN で、定義済み一覧を含める', async () => {
  const config = await shared();
  for (const name of ['nope', 'constructor', '__proto__', 'toString']) {
    assert.throws(() => resolvePreset(config, name), (e) =>
      isPresetError('EPRESET_UNKNOWN')(e) && /bug-triage/.test(e.message) && /plain/.test(e.message), name);
    assert.throws(() => getPreset(config, name), isPresetError('EPRESET_UNKNOWN'), name);
  }
});

test('B9: 値の中の $& $1 $$ $\' はそのまま出力される', async () => {
  const config = await shared();
  const value = "$& $1 $$ $' $`";
  assert.equal(resolvePreset(config, 'bug-triage', { symptom: value }).instruction, `症状: ${value} / 対象: 全体`);
});

test('B10: 値の中の {{other}} や \\{{ は再展開も解釈もされない', async () => {
  const config = await shared();
  assert.equal(
    resolvePreset(config, 'bug-triage', { symptom: '{{component}}', component: '\\{{x}}' }).instruction,
    '症状: {{component}} / 対象: \\{{x}}');
});

test('B11: 定義側の \\{{ は文字の {{ になり、単独の }} は文字のまま', async () => {
  const config = await shared();
  assert.equal(resolvePreset(config, 'lit', { x: 'v' }).instruction, '{{literal}} と }} と v');
});

test('B12: 同じプレースホルダは何回出ても置換される', async () => {
  const config = await cfgOf([P({ instruction: '{{focus}} と {{focus}}', arguments: [ARG()] })]);
  assert.equal(resolvePreset(config, 'p', { focus: 'a' }).instruction, 'a と a');
});

test('B13: args は undefined / null なら {}、プレーンオブジェクト以外は EPRESET_ARGS', async () => {
  const config = await shared();
  assert.equal(resolvePreset(config, 'plain', undefined).taskId, 'spec');
  assert.equal(resolvePreset(config, 'plain', null).taskId, 'spec');
  assert.throws(() => resolvePreset(config, 'plain', 'x'), isPresetError('EPRESET_ARGS'));
  assert.throws(() => resolvePreset(config, 'plain', []), isPresetError('EPRESET_ARGS'));
});

test('B14: 戻り値を書き換えても設定は変わらず、余計なキーも無い', async () => {
  const config = await shared();
  const r = resolvePreset(config, 'bug-triage', { symptom: 's' });
  assert.deepEqual(r.sourceIds, ['api', 'web']);
  r.sourceIds.push('zzz');
  assert.deepEqual(resolvePreset(config, 'bug-triage', { symptom: 's' }).sourceIds, ['api', 'web']);
  assert.deepEqual(config.presets[0].sources, ['api', 'web']);
  for (const k of ['modelOverride', 'dryRun', 'save']) assert.ok(!(k in r), k);
});

test('B15: 展開後の instruction が空なら EPRESET_EMPTY_INSTRUCTION', async () => {
  const config = await shared();
  assert.throws(() => resolvePreset(config, 'opt-only', {}), isPresetError('EPRESET_EMPTY_INSTRUCTION'));
  assert.throws(() => resolvePreset(config, 'opt-only', { opt: '  ' }), isPresetError('EPRESET_EMPTY_INSTRUCTION'));
  assert.equal(resolvePreset(config, 'opt-only', { opt: 'x' }).instruction, 'x');
});

test('B16: 同じ入力なら同じ結果（決定的）', async () => {
  const config = await shared();
  const a = resolvePreset(config, 'bug-triage', { symptom: 's', component: 'c' });
  const b = resolvePreset(config, 'bug-triage', { symptom: 's', component: 'c' });
  assert.equal(a.instruction, '症状: s / 対象: c');
  assert.deepEqual(a, b);
});

// ============================================================ C. runTask との結合
test('C1: 解決結果を runTask(dryRun) に渡すと、展開後の指示・effort・ソース絞り込みが効く', async () => {
  const preset = {
    name: 'api-only', task: 'bug', effort: 'low', sources: ['api'],
    instruction: 'symptom: {{symptom}} component: retry',
    arguments: [{ name: 'symptom' }],
  };
  const { dir, file } = await makeDir({ presets: [preset] });
  try {
    const config = await loadConfig(file);
    const r = resolvePreset(config, 'api-only', { symptom: 'timeout' });
    assert.equal(r.taskId, 'bug');
    assert.equal(r.instruction, 'symptom: timeout component: retry');
    await syncSources(config, {});
    await buildIndex(config, { embed: false });
    // sources 絞り込みが無ければ web も証拠に入ることを先に確認する（空振り防止）
    const all = await runTask(config, { taskId: 'bug', instruction: r.instruction, effort: 'low', dryRun: true, save: false });
    assert.ok(new Set(all.pack.items.map((i) => i.sourceId)).has('web'), '前提: 絞り込み無しなら web が入る');

    const out = await runTask(config, { ...r, dryRun: true, save: false });
    assert.equal(out.meta.queries[0], r.instruction);
    assert.equal(out.meta.effort, 'low');
    assert.ok(out.pack.items.length > 0);
    assert.ok(out.pack.items.every((i) => ['api'].includes(i.sourceId)), JSON.stringify(out.pack.items.map((i) => i.sourceId)));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('C2: preset 経由でも allowLlmUpload=false の安全ゲートは迂回できない', async () => {
  const preset = { name: 'gate', task: 'spec', effort: 'low', instruction: 'timeout retry' };
  const { dir, file } = await makeDir({
    presets: [preset],
    overrides: { llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'TEST_LLM_KEY' }, security: { allowLlmUpload: false } },
  });
  const saved = process.env.TEST_LLM_KEY;
  process.env.TEST_LLM_KEY = 'dummy';
  try {
    const config = await loadConfig(file);
    await syncSources(config, {});
    await buildIndex(config, { embed: false });
    await assert.rejects(
      () => runTask(config, { ...resolvePreset(config, 'gate'), save: false }),
      /allowLlmUpload=false/);
  } finally {
    if (saved === undefined) delete process.env.TEST_LLM_KEY; else process.env.TEST_LLM_KEY = saved;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ============================================================ D. doctor
function doctor(file) {
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json', '-c', file], { encoding: 'utf8' });
  return { checks: JSON.parse(r.stdout), status: r.status, stderr: r.stderr };
}

test('D1: doctor は検証を通った preset ごとに ok の行を出す', async () => {
  const { dir, file } = await makeDir({ presets: [BUG_TRIAGE] });
  try {
    const { checks } = doctor(file);
    const row = checks.find((c) => c.name === 'preset "bug-triage"');
    assert.ok(row, JSON.stringify(checks.map((c) => c.name)));
    assert.equal(row.ok, true);
    assert.match(row.detail, /task=bug/);
    assert.match(row.detail, /effort=deep/);
    assert.match(row.detail, /sources=api,web/);
    assert.match(row.detail, /symptom\(必須\)/);
    assert.match(row.detail, /component\(任意\)/);
    assert.ok(!row.detail.includes('{{symptom}}'), 'instruction の本文は出さない');
    assert.equal(checks.find((c) => c.name === '設定の妥当性').detail, '2 ソース');
    assert.ok(!checks.some((c) => c.name === 'presets の定義'));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('D2: 不正な preset があると presets の定義が ok:false になり、設定の妥当性は ok のまま', async () => {
  const { dir, file } = await makeDir({ presets: [P({ model: 'x' })] });
  try {
    const { checks, status } = doctor(file);
    const row = checks.find((c) => c.name === 'presets の定義');
    assert.ok(row, JSON.stringify(checks.map((c) => c.name)));
    assert.equal(row.ok, false);
    assert.match(row.detail, /presets\[0\]/);
    assert.equal(checks.find((c) => c.name === '設定の妥当性').ok, true);
    assert.equal(status, 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
