import { estimateTokens, truncateToTokens } from '../util/tokens.js';
import { redactText } from '../util/redact.js';

function lineUrl(c) {
  if (!c.url) return null;
  if (c.sourceType === 'github' && c.kind !== 'issue' && c.kind !== 'pr') {
    return c.start ? `${c.url}#L${c.start}-L${c.end}` : c.url;
  }
  return c.url;
}

export function citationLabel(c) {
  const loc = c.kind === 'doc' || c.kind === 'ticket' ? '' : `:${c.start}-${c.end}`;
  return `${c.sourceId}/${c.path}${loc}`;
}

/**
 * 検索結果 → 証拠パック。
 *  - トークン予算内に収める（超過分は落とす。要約で潰さないので逐語照合が常に可能）
 *  - E1..En の安定 ID を振る（LLM はこの ID でしか引用できない）
 *  - 同一ファイルの隣接チャンクは結合して重複を減らす
 */
export function buildEvidencePack(results, { budgetTokens, maxItems = 200, headerTokens = 0, redact = true }) {
  const merged = [];
  const sorted = [...results].sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : a.start - b.start));
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.docId === r.docId && r.start <= last.end + 3) {
      if (r.end > last.end) {
        const overlapLines = Math.max(0, last.end - r.start + 1);
        const extra = r.text.split('\n').slice(overlapLines).join('\n');
        last.text += (extra ? '\n' + extra : '');
        last.end = r.end;
        last.score = Math.max(last.score, r.score);
      }
    } else {
      merged.push({ ...r });
    }
  }
  merged.sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : 1));

  const items = [];
  let used = headerTokens;
  let redactedCount = 0;
  const redactedKinds = new Set();
  for (const c of merged) {
    if (items.length >= maxItems) break;
    // 墨消しは「パック生成時」に一度だけ行う。
    // LLM に渡す本文・保存される evidence.json・逐語引用の照合対象がすべて同一になり、
    // 墨消しによって検証が壊れることがない。
    let body = c.text;
    if (redact) {
      const r = redactText(body);
      body = r.text;
      if (r.count) { redactedCount += r.count; for (const k of r.kinds) redactedKinds.add(k); }
    }
    const overhead = 60;
    let tok = estimateTokens(body) + overhead;
    if (used + tok > budgetTokens) {
      const remain = budgetTokens - used - overhead;
      if (remain < 250) break;
      const trimmed = truncateToTokens(body, remain);
      items.push(mkItem(items.length + 1, c, trimmed, true));
      used += estimateTokens(trimmed) + overhead;
      break;
    }
    items.push(mkItem(items.length + 1, c, body, false));
    used += tok;
  }
  return { items, tokens: used, droppedCount: merged.length - items.length, redactedCount, redactedKinds: [...redactedKinds] };
}

function mkItem(n, c, text, truncated) {
  return {
    id: `E${n}`,
    sourceId: c.sourceId,
    sourceType: c.sourceType,
    kind: c.kind,
    path: c.path,
    title: c.title,
    start: c.start,
    end: c.end,
    version: c.version,
    url: lineUrl(c),
    label: citationLabel(c),
    truncated,
    text,
  };
}

/** LLM に渡す証拠ブロック（プロンプトキャッシュが効くように決定的な整形にする） */
export function renderEvidenceBlock(pack) {
  const parts = [];
  for (const e of pack.items) {
    parts.push(
      `<evidence id="${e.id}" source="${e.sourceId}" type="${e.sourceType}" kind="${e.kind}" ` +
      `path="${escapeAttr(e.path)}" lines="${e.start}-${e.end}" version="${escapeAttr(String(e.version ?? ''))}"` +
      (e.url ? ` url="${escapeAttr(e.url)}"` : '') + (e.truncated ? ' truncated="true"' : '') + '>\n' +
      e.text + `\n</evidence>`
    );
  }
  return parts.join('\n\n');
}

function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
