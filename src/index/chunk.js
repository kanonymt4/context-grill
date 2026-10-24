import { estimateTokens } from '../util/tokens.js';
import { sha256 } from '../util/misc.js';
import { redactPemBlocks } from '../util/redact.js';

// DECL_RE は \s+ と \s* が重なり二乗になるため、極端に長い行は宣言行として扱わない
const DECL_MAX_LINE = 2000;

const DECL_RE = /^(\s{0,4})(export\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|async\s+|@)*\s*(function|class|interface|type|enum|struct|const|let|var|def|func|fn|module|namespace|impl|trait|package|describe|it|test|CREATE\s+TABLE|CREATE\s+OR\s+REPLACE)\b/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * コード: 宣言境界を優先した行ウィンドウ分割（行番号を保持 → 引用検証と permalink に必須）
 * 文書: 見出し階層で分割 → 長い節はさらに文字数で分割
 * どちらも決定的（同じ入力なら常に同じチャンク）。
 */
export function chunkDocument(rawDoc, cfg) {
  // PEM 秘密鍵は分割の前に文書単位で伏せる（チャンク単位の redactText では BEGIN の無い後続チャンクが素通りする）。
  // 行数は保たれるので分割位置・行番号は変わらない。キャッシュ済みの doc.text は書き換えない。
  const doc = { ...rawDoc, text: redactPemBlocks(rawDoc.text) };
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

/**
 * 本文を行に分ける。末尾が改行のとき split の最後に出る空要素は行ではないので除く
 * （数えると end・total が実際の行数 +1 になり、存在しない行を引用元として示す）。
 * CRLF の '\r' は各行に残す。
 */
function splitLines(text) {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** pos 以降で最初の行頭（pos 自身が行頭ならそれ）。無ければ text.length */
function lineStartAtOrAfter(text, pos) {
  if (pos <= 0 || text[pos - 1] === '\n') return pos;
  const i = text.indexOf('\n', pos);
  return i < 0 ? text.length : i + 1;
}

export function chunkCode(doc, cfg) {
  const lines = splitLines(doc.text);
  const maxLines = cfg.maxLines ?? 110;
  const overlap = cfg.overlapLines ?? 12;
  const maxChars = cfg.maxChars ?? 6000;
  const boundaries = new Set();
  for (let i = 0; i < lines.length; i++) if (lines[i].length <= DECL_MAX_LINE && DECL_RE.test(lines[i])) boundaries.add(i);

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
  const lines = splitLines(doc.text);
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
        else {
          // 切る位置は行末（直後が改行）に揃える。改行が無い（1 行が上限を超える）ときだけ行の途中で切る
          const nl = body.lastIndexOf('\n', end);
          if (nl > pos) end = nl;
        }
      }
      // 行の途中で始まる／終わるチャンク。pack はこれを行単位の重なりとして結合してはならない
      const startsMid = pos > 0 && body[pos - 1] !== '\n';
      const endsMid = end < body.length && body[end] !== '\n';
      const slice = body.slice(pos, end);
      const lineOffset = body.slice(0, pos).split('\n').length - 1;
      const nLines = slice.split('\n').length;
      if (slice.trim()) {
        const c = baseChunk(doc, idx++, sec.startLine + lineOffset, sec.startLine + lineOffset + nLines - 1, slice, title);
        if (startsMid || endsMid) c.partial = true;
        out.push(c);
      }
      if (end >= body.length) break;
      // 重なりは行単位で取る（行頭に揃える）。行の途中で切った直後だけは従来どおり文字数で戻る
      const back = Math.max(end - overlap, pos + 1);
      pos = endsMid ? back : lineStartAtOrAfter(body, back);
    }
  }
  if (out.length === 0 && doc.text.trim()) {
    out.push(baseChunk(doc, 0, 1, lines.length, doc.text.slice(0, maxChars), doc.title));
  }
  return out;
}
