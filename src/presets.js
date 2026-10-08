import { TASKS } from './tasks/index.js';

// preset: 設定ファイルの `presets` に書く「名前付きの調査テンプレート」。
//
// 解決（resolvePreset）は決定的な文字列処理だけで行い、LLM もネットワークも使わない。
// 解決結果は runTask にそのまま渡せる形（taskId / instruction / effort / sourceIds）で、
// 送信可否の判定（allowLlmUpload / --offline）は runTask 側に任せる。ここでは迂回も重複もしない。
//
// pipeline.js を import しないこと（config.js → presets.js → pipeline.js → config.js の循環になる）。
// tasks/index.js は util/misc.js しか import しないので安全。

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ARG_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PLACEHOLDER_RE = /^\{\{([a-z][a-z0-9_]{0,31})\}\}/;

const PRESET_KEYS = ['name', 'description', 'task', 'effort', 'sources', 'instruction', 'arguments'];
const ARG_KEYS = ['name', 'description', 'required', 'default'];

// 専用の案内を出すキー。送信先モデルを preset から変えられないようにするためのもの
const MODEL_KEYS = ['model', 'modelOverride', 'llm', 'provider'];

export class PresetError extends Error {
  /**
   * @param {'EPRESET_UNKNOWN'|'EPRESET_INVALID'|'EPRESET_ARGS'|'EPRESET_EMPTY_INSTRUCTION'} code
   * @param {string} message
   * @param {{ preset?: string|null, issues?: Array<{code: string, arg: string}> }} [extra]
   */
  constructor(code, message, { preset = null, issues = [] } = {}) {
    super(message);
    this.name = 'PresetError';
    this.code = code;
    this.preset = preset;
    this.issues = issues;
  }
}

const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------ テンプレート
/**
 * 指示文を「文字列」と「引数の参照」の列に分解する。
 * - `{{name}}` が引数。空白や大文字は不可
 * - `\{{` は文字の `{{`。単独の `}}` は文字のまま
 * - 上記以外の `{{` は errors に積む（`${...}` は何も特別扱いしない）
 * @returns {{ parts: Array<string|{arg: string}>, names: string[], errors: string[] }}
 */
export function parseTemplate(text) {
  const parts = [];
  const names = [];
  const errors = [];
  let lit = '';
  const flush = () => { if (lit) { parts.push(lit); lit = ''; } };
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('\\{{', i)) { lit += '{{'; i += 3; continue; }
    if (text.startsWith('{{', i)) {
      const m = PLACEHOLDER_RE.exec(text.slice(i));
      if (m) {
        flush();
        parts.push({ arg: m[1] });
        if (!names.includes(m[1])) names.push(m[1]);
        i += m[0].length;
        continue;
      }
      const near = text.slice(i, i + 12).replace(/\n/g, ' ');
      errors.push(`${i} 文字目の "{{" を引数として解釈できません（"${near}"）。{{name}}（小文字英字で始まり、空白なし）と書くか、文字の {{ は \\{{ と書いてください`);
      lit += '{{';
      i += 2;
      continue;
    }
    lit += text[i];
    i += 1;
  }
  flush();
  return { parts, names, errors };
}

// ------------------------------------------------------------ 定義の検証
function labelOf(index, raw) {
  const name = isPlainObject(raw) ? own(raw, 'name') : undefined;
  return typeof name === 'string' && name ? `presets[${index}] ("${name}")` : `presets[${index}]`;
}

function checkArguments(where, rawArgs, errs) {
  // 検証に成功した引数の定義（instruction との突き合わせ用）。配列でなければ null
  if (rawArgs === undefined) return [];
  if (!Array.isArray(rawArgs)) {
    errs.push(`${where}.arguments は配列で書く必要があります（例: "arguments": [{ "name": "focus" }]）`);
    return null;
  }
  const declared = [];
  const seen = new Set();
  for (const [j, a] of rawArgs.entries()) {
    const at = `${where}.arguments[${j}]`;
    if (!isPlainObject(a)) { errs.push(`${at} はオブジェクトで書く必要があります`); continue; }
    for (const k of Object.keys(a)) {
      if (k === '__proto__') errs.push(`${at}.__proto__ は使えません`);
      else if (k.startsWith('_') || ARG_KEYS.includes(k)) continue;
      else errs.push(`${at}.${k} は未知のキーです（使えるキー: ${ARG_KEYS.join(', ')}）`);
    }
    const name = own(a, 'name');
    let nameOk = false;
    if (typeof name !== 'string' || !ARG_NAME_RE.test(name)) {
      errs.push(`${at}.name は ${ARG_NAME_RE} に合う文字列で指定してください（現在: ${JSON.stringify(name)}）`);
    } else if (seen.has(name)) {
      errs.push(`${at}.name "${name}" が重複しています`);
    } else {
      seen.add(name);
      nameOk = true;
    }
    const description = own(a, 'description');
    if (description !== undefined && typeof description !== 'string') errs.push(`${at}.description は文字列で指定してください`);
    const required = own(a, 'required');
    const hasDefault = Object.hasOwn(a, 'default');
    const def = own(a, 'default');
    if (required !== undefined && typeof required !== 'boolean') {
      errs.push(`${at}.required は true / false で指定してください（現在: ${JSON.stringify(required)}）`);
    } else if (required === false) {
      if (!hasDefault) errs.push(`${at} は required:false のため default が必要です（空にするなら "default": ""）`);
      else if (typeof def !== 'string') errs.push(`${at}.default は文字列で指定してください`);
    } else if (hasDefault) {
      errs.push(`${at} は必須引数のため default を書けません（任意にするなら "required": false を付けてください）`);
    }
    if (nameOk) {
      declared.push({
        name,
        description: typeof description === 'string' ? description : null,
        required: required !== false,
        default: required === false && typeof def === 'string' ? def : null,
      });
    }
  }
  return declared;
}

/** 1 件の preset を検証する。errors が空なら value に正規化済みの定義が入る */
function checkPreset(config, raw, index) {
  const errs = [];
  const where = labelOf(index, raw);
  if (!isPlainObject(raw)) {
    return { errors: [`${where} はオブジェクトで書く必要があります`], value: null };
  }

  for (const k of Object.keys(raw)) {
    if (k === '__proto__') errs.push(`${where}.__proto__ は使えません`);
    else if (MODEL_KEYS.includes(k)) errs.push(`${where}.${k} は指定できません（preset から送信先モデルは変えられません。モデルは設定の llm.model で指定します）`);
    else if (k === 'source') errs.push(`${where}.source は使えません。対象ソースは sources（配列）と書いてください（例: "sources": ["api"]）`);
    else if (k === 'dryRun' || k === 'dry_run') errs.push(`${where}.${k} は指定できません（dry-run は実行時に指定します）`);
    else if (k.startsWith('_') || PRESET_KEYS.includes(k)) continue;
    else errs.push(`${where}.${k} は未知のキーです（使えるキー: ${PRESET_KEYS.join(', ')}）`);
  }

  const name = own(raw, 'name');
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    errs.push(`${where}.name は ${NAME_RE} に合う文字列で指定してください（現在: ${JSON.stringify(name)}）`);
  }

  const description = own(raw, 'description');
  if (description !== undefined && typeof description !== 'string') errs.push(`${where}.description は文字列で指定してください`);

  const task = own(raw, 'task');
  const taskIds = Object.keys(TASKS);
  if (typeof task !== 'string' || !Object.hasOwn(TASKS, task)) {
    errs.push(`${where}.task は必須で、${taskIds.join('|')} のいずれかを指定してください（現在: ${JSON.stringify(task)}）`);
  }

  const effort = own(raw, 'effort');
  if (effort !== undefined) {
    const levels = isPlainObject(config.effortPresets) ? config.effortPresets : {};
    if (typeof effort !== 'string' || !Object.hasOwn(levels, effort)) {
      errs.push(`${where}.effort は ${Object.keys(levels).join('|')} のいずれかを指定してください（現在: ${JSON.stringify(effort)}）`);
    }
  }

  let sources = null;
  const rawSources = own(raw, 'sources');
  if (rawSources !== undefined) {
    const known = new Set((Array.isArray(config.sources) ? config.sources : []).map((s) => s?.id));
    const list = typeof rawSources === 'string' ? [rawSources] : rawSources;
    if (!Array.isArray(list)) {
      errs.push(`${where}.sources は文字列の配列で指定してください（例: "sources": ["api", "web"]）`);
    } else if (list.length === 0) {
      errs.push(`${where}.sources が空です。全ソースを対象にする場合は sources を省略してください`);
    } else {
      let ok = true;
      const seenIds = new Set();
      for (const id of list) {
        if (typeof id !== 'string') { errs.push(`${where}.sources の要素は文字列で指定してください（現在: ${JSON.stringify(id)}）`); ok = false; continue; }
        if (seenIds.has(id)) { errs.push(`${where}.sources "${id}" が重複しています`); ok = false; continue; }
        seenIds.add(id);
        if (!known.has(id)) {
          ok = false;
          errs.push(
            `${where}.sources "${id}" は設定の sources に定義されていません（定義済みの id: ${[...known].join(', ') || 'なし'}）` +
            (id.includes(',') ? '。複数指定はカンマ区切りの文字列ではなく配列で書いてください（例: "sources": ["api", "web"]）' : ''));
        }
      }
      if (ok) sources = [...list];
    }
  }

  const instruction = own(raw, 'instruction');
  let tpl = null;
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    errs.push(`${where}.instruction は必須で、空でない文字列で指定してください`);
  } else {
    tpl = parseTemplate(instruction);
    for (const e of tpl.errors) errs.push(`${where}.instruction ${e}`);
  }

  const declared = checkArguments(where, own(raw, 'arguments'), errs);
  if (tpl && declared) {
    const declaredNames = declared.map((a) => a.name);
    for (const n of tpl.names) {
      if (!declaredNames.includes(n)) errs.push(`${where}.instruction で使われている {{${n}}} が arguments に宣言されていません`);
    }
    for (const n of declaredNames) {
      if (!tpl.names.includes(n)) errs.push(`${where}.arguments の "${n}" が instruction で使われていません（{{${n}}} と書いてください）`);
    }
  }

  if (errs.length) return { errors: errs, value: null };
  return {
    errors: [],
    value: {
      name,
      description: typeof description === 'string' ? description : null,
      task,
      effort: effort ?? 'normal',
      sources,
      instruction,
      arguments: declared,
    },
  };
}

const ARRAY_HINT = 'presets は配列で書く必要があります（例: "presets": [ { "name": "bug-triage", "task": "bug", "instruction": "…" } ]）';

/** 全 preset を検証し、定義順のエントリと、全体に関わるエラーを返す */
function analyze(config) {
  const list = config?.presets;
  if (list === undefined || list === null) return { entries: [], topErrors: [] };
  if (!Array.isArray(list)) return { entries: [], topErrors: [ARRAY_HINT] };
  const entries = list.map((raw, index) => ({ index, raw, ...checkPreset(config, raw, index) }));

  // 同名の重複は、該当するすべての preset を使えなくする
  const byName = new Map();
  for (const e of entries) {
    const n = isPlainObject(e.raw) ? own(e.raw, 'name') : undefined;
    if (typeof n !== 'string') continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(e);
  }
  for (const [n, group] of byName) {
    if (group.length < 2) continue;
    const at = group.map((e) => `presets[${e.index}]`).join(' と ');
    for (const e of group) {
      e.errors.push(`${at} の name "${n}" が重複しています。name は preset ごとに一意にしてください`);
      e.value = null;
    }
  }
  return { entries, topErrors: [] };
}

/**
 * 設定の presets を検証し、エラー文字列の配列を返す（throw しない）。
 * 空配列なら定義はすべて正しい。
 */
export function validatePresets(config) {
  const { entries, topErrors } = analyze(config);
  return [...new Set([...topErrors, ...entries.flatMap((e) => e.errors)])];
}

/**
 * 検証を通った preset だけを、定義順に複製して返す。不正な preset は含めない。
 * エラーを知りたい呼び出し側は validatePresets を併用すること。
 */
export function listPresets(config) {
  return analyze(config).entries.filter((e) => e.value).map((e) => structuredClone(e.value));
}

const validNames = (entries) => entries.filter((e) => e.value).map((e) => e.value.name);
const namesText = (names) => (names.length ? names.join(', ') : 'なし');

/** 名前で 1 件取り出す。未定義は EPRESET_UNKNOWN、定義が不正なら EPRESET_INVALID */
export function getPreset(config, name) {
  const { entries, topErrors } = analyze(config);
  if (topErrors.length) {
    throw new PresetError('EPRESET_INVALID', `preset "${name}": 設定の presets が不正です。\n  - ${topErrors.join('\n  - ')}`, { preset: String(name) });
  }
  // 名前の照合は文字列の完全一致のみ（"constructor" 等をプロトタイプから拾わない）
  const hits = entries.filter((e) => isPlainObject(e.raw) && typeof own(e.raw, 'name') === 'string' && own(e.raw, 'name') === name);
  if (hits.length === 0) {
    throw new PresetError(
      'EPRESET_UNKNOWN',
      `preset "${String(name)}" は定義されていません（定義済み: ${namesText(validNames(entries))}）`,
      { preset: String(name) });
  }
  const errors = [...new Set(hits.flatMap((e) => e.errors))];
  if (errors.length) {
    throw new PresetError(
      'EPRESET_INVALID',
      `preset "${name}" の定義が不正です。設定ファイルを直してください（context-grill doctor で確認できます）:\n  - ${errors.join('\n  - ')}`,
      { preset: name });
  }
  return structuredClone(hits[0].value);
}

// ------------------------------------------------------------ 解決
/**
 * preset と引数から、runTask に渡す { taskId, instruction, effort, sourceIds } を作る。
 * dryRun / modelOverride / save は含めない（呼び出し側が実行時に決める）。
 * @param {object} args 引数名 → 文字列。プレーンオブジェクトのみ
 */
export function resolvePreset(config, name, args = {}) {
  const preset = getPreset(config, name);
  const input = args ?? {};
  if (!isPlainObject(input)) {
    throw new PresetError(
      'EPRESET_ARGS',
      `preset "${name}": 引数はオブジェクトで渡してください（例: { "${preset.arguments[0]?.name ?? 'focus'}": "値" }）`,
      { preset: name });
  }

  const declaredText = namesText(preset.arguments.map((a) => a.name));
  const issues = [];
  const lines = [];
  for (const key of Object.keys(input)) {
    if (!preset.arguments.some((a) => a.name === key)) {
      issues.push({ code: 'ARG_UNKNOWN', arg: key });
      lines.push(`引数 "${key}" は宣言されていません（宣言済み: ${declaredText}）`);
    }
  }
  const values = {};
  for (const a of preset.arguments) {
    if (!Object.hasOwn(input, a.name)) {
      if (a.required) { issues.push({ code: 'ARG_MISSING', arg: a.name }); lines.push(`必須の引数 "${a.name}" がありません`); }
      else values[a.name] = a.default;
      continue;
    }
    const v = input[a.name];
    if (typeof v !== 'string') {
      issues.push({ code: 'ARG_TYPE', arg: a.name });
      lines.push(`引数 "${a.name}" は文字列で渡してください（現在: ${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}）`);
    } else if (v.trim() === '') {
      if (a.required) { issues.push({ code: 'ARG_EMPTY', arg: a.name }); lines.push(`必須の引数 "${a.name}" が空です`); }
      else values[a.name] = a.default;
    } else {
      values[a.name] = v;
    }
  }
  if (issues.length) {
    throw new PresetError(
      'EPRESET_ARGS',
      `preset "${name}": 引数が不正です:\n  - ${lines.join('\n  - ')}`,
      { preset: name, issues });
  }

  // 部品を連結して組み立てる。String.replace は値の中の $& $1 $$ を解釈してしまうので使わない。
  // 値は再走査しないので、値に {{...}} が含まれていても展開されない。
  const { parts } = parseTemplate(preset.instruction);
  const instruction = parts.map((p) => (typeof p === 'string' ? p : values[p.arg])).join('');
  if (instruction.trim() === '') {
    throw new PresetError(
      'EPRESET_EMPTY_INSTRUCTION',
      `preset "${name}": 引数を展開した結果、指示文が空になりました。引数に値を渡してください`,
      { preset: name });
  }
  return {
    taskId: preset.task,
    instruction,
    effort: preset.effort,
    sourceIds: preset.sources ? [...preset.sources] : null,
  };
}
