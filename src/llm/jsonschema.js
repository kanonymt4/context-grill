// 依存ゼロの JSON Schema サブセット検証器（type/required/properties/items/enum/minLength/minItems/additionalProperties）
export function validate(schema, value, pathStr = '$') {
  const errs = [];
  if (!schema) return errs;
  const t = schema.type;
  if (t) {
    const types = Array.isArray(t) ? t : [t];
    if (!types.some((tt) => matchType(tt, value))) {
      errs.push(`${pathStr}: 型が ${types.join('|')} ではありません (実際: ${jsType(value)})`);
      return errs;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${pathStr}: 値 ${JSON.stringify(value)} は許可されていません (許可: ${schema.enum.join(', ')})`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${pathStr}: ${schema.minLength} 文字以上が必要です`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${pathStr}: ${schema.maxLength} 文字以下にしてください`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${pathStr}: パターン ${schema.pattern} に一致しません`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${pathStr}: 要素が ${schema.minItems} 個以上必要です`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${pathStr}: 要素は ${schema.maxItems} 個以下にしてください`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${pathStr}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) {
      if (value[r] === undefined || value[r] === null) errs.push(`${pathStr}.${r}: 必須項目がありません`);
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(sub, v, `${pathStr}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${pathStr}.${k}: 未定義のプロパティです`);
    }
  }
  return errs;
}

function jsType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function matchType(t, v) {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return true;
  }
}

/** モデル出力から JSON を頑健に取り出す（コードフェンス・前置き対策） */
export function extractJson(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { const p = tryParse(fence[1].trim()); if (p) return p; }
  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { const p = tryParse(trimmed.slice(start, i + 1)); if (p) return p; } }
    }
  }
  return null;
}
function tryParse(s) { try { return JSON.parse(s); } catch { return null; } }
