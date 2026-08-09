import { estimateTokens } from '../util/tokens.js';
import { sha256 } from '../util/misc.js';

const DECL_RE = /^(\s{0,4})(export\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|async\s+|@)*\s*(function|class|interface|type|enum|struct|const|let|var|def|func|fn|module|namespace|impl|trait|package|describe|it|test|CREATE\s+TABLE|CREATE\s+OR\s+REPLACE)\b/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * コード: 宣言境界を優先した行ウィンドウ分割（行番号を保持 → 引用検証と permalink に必須）
 * 文書: 見出し階層で分割 → 長い節はさらに文字数で分割
 * どちらも決定的（同じ入力なら常に同じチャンク）。
 */
export function chunkDocument(doc, cfg) {
  if (doc.kind === 'doc' || doc.kind === 'issue' || doc.kind === 'pr' || doc.kind === 'ticket') {
    return chunkText(doc, cfg.doc);
  }
  return chunkCode(doc, cfg.code);
}

function baseChunk(doc, i, startLine, endLine, text, title) {
  return {
    id: `${doc.docId}#${i}`,
    docId: doc.docId,
    sourceId: doc.sourceId,
    sourceType: doc.sourceType,
    path: doc.path,
    title: title || doc.title,
    kind: doc.kind,
    lang: doc.lang,
    url: doc.url,
    version: doc.version,
    meta: doc.meta,
    start: startLine,
    end: endLine,
    hash: sha256(text),
    ntok: estimateTokens(text),
    text,
  };
}

export function chunkCode(doc, cfg) {
  const lines = doc.text.split('\n');
  const maxLines = cfg.maxLines ?? 110;
  const overlap = cfg.overlapLines ?? 12;
  const maxChars = cfg.maxChars ?? 6000;
  const boundaries = new Set();
  for (let i = 0; i < lines.length; i++) if (DECL_RE.test(lines[i])) boundaries.add(i);

  const out = [];
  let start = 0;
  let idx = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + maxLines);
    // maxLines 手前で最も近い宣言境界に合わせる（文脈を切らないため）
    if (end < lines.length) {
      for (let j = end; j > start + Math.floor(maxLines * 0.5); j--) {
        if (boundaries.has(j)) { end = j; break; }
      }
    }
    let text = lines.slice(start, end).join('\n');
    while (text.length > maxChars && end > start + 1) { end--; text = lines.slice(start, end).join('\n'); }
    if (text.trim().length > 0) {
      const enclosing = findEnclosingSymbol(lines, start);
      out.push(baseChunk(doc, idx++, start + 1, end, text, enclosing ? `${doc.path} › ${enclosing}` : doc.path));
    }
    if (end >= lines.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

function findEnclosingSymbol(lines, at) {
  for (let i = at; i >= 0 && i > at - 400; i--) {
    const m = lines[i].match(/(?:function|class|interface|type|enum|struct|def|func|fn|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (m) return m[1];
  }
  return null;
}

export function chunkText(doc, cfg) {
  const maxChars = cfg.maxChars ?? 2200;
  const overlap = cfg.overlapChars ?? 220;
  const lines = doc.text.split('\n');
  const sections = [];
  let cur = { heading: doc.title, path: [], startLine: 1, lines: [] };
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (m) {
      if (cur.lines.join('\n').trim()) sections.push(cur);
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
      cur = { heading: m[2].trim(), path: stack.map((s) => s.title), startLine: i + 1, lines: [lines[i]] };
    } else {
      cur.lines.push(lines[i]);
    }
  }
  if (cur.lines.join('\n').trim()) sections.push(cur);

  const out = [];
  let idx = 0;
  for (const sec of sections) {
    const body = sec.lines.join('\n');
    const title = sec.path.length ? `${doc.title} › ${sec.path.join(' › ')}` : doc.title;
    if (body.length <= maxChars) {
      out.push(baseChunk(doc, idx++, sec.startLine, sec.startLine + sec.lines.length - 1, body, title));
      continue;
    }
    let pos = 0;
    while (pos < body.length) {
      let end = Math.min(body.length, pos + maxChars);
      if (end < body.length) {
        const brk = body.lastIndexOf('\n\n', end);
        if (brk > pos + maxChars * 0.4) end = brk;
      }
      const slice = body.slice(pos, end);
      const lineOffset = body.slice(0, pos).split('\n').length - 1;
      const nLines = slice.split('\n').length;
      if (slice.trim()) {
        out.push(baseChunk(doc, idx++, sec.startLine + lineOffset, sec.startLine + lineOffset + nLines - 1, slice, title));
      }
      if (end >= body.length) break;
      pos = Math.max(end - overlap, pos + 1);
    }
  }
  if (out.length === 0 && doc.text.trim()) {
    out.push(baseChunk(doc, 0, 1, lines.length, doc.text.slice(0, maxChars), doc.title));
  }
  return out;
}
