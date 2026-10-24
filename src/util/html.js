const BLOCK = /^(p|div|br|li|tr|h[1-6]|table|thead|tbody|section|article|pre|blockquote|ul|ol|dl|dt|dd)$/i;

/** 改行の直前にある空白とタブを取り除く（/[ \t]+\n/g と同じ結果を線形時間で得る。正規表現は空白の連続で二乗になる） */
function trimLineEnds(s) {
  let out = '';
  let start = 0;
  for (;;) {
    const nl = s.indexOf('\n', start);
    if (nl === -1) return out + s.slice(start);
    let end = nl;
    while (end > start && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
    out += s.slice(start, end) + '\n';
    start = nl + 1;
  }
}

/**
 * <ac:link>…<ri:page ri:content-title="T"/>…</ac:link> を [[T]] にする。
 * 1 本の正規表現（[\s\S]*? を 2 つ含む）だと、閉じない <ac:link> の繰り返しで開始位置ごとに末尾まで
 * 走査して二乗になる。開き・ページ参照・閉じを位置の単調な走査で順に探し、全体を線形にする。
 */
function replaceAcLinks(s) {
  const open = /<ac:link[^<>]*>/gi;
  const page = /<ri:page[^<>]*ri:content-title="([^"]*)"[^<>]*\/>/gi;
  const close = /<\/ac:link>/gi;
  let out = '';
  let pos = 0;
  for (;;) {
    open.lastIndex = pos;
    const o = open.exec(s);
    if (!o) break;
    page.lastIndex = o.index + o[0].length;
    const p = page.exec(s);
    if (!p) break;
    close.lastIndex = p.index + p[0].length;
    const c = close.exec(s);
    if (!c) break;
    out += s.slice(pos, o.index) + `[[${p[1]}]]`;
    pos = c.index + c[0].length;
  }
  return out + s.slice(pos);
}

/** Confluence storage format / 一般的な HTML をプレーンテキスト化（依存ゼロ） */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  // コードマクロは fenced block として温存（仕様書内のコードは一次資料として重要）
  s = s.replace(/<ac:structured-macro[^>]*ac:name="code"[\s\S]*?<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/gi,
    (_, code) => `\n\`\`\`\n${code}\n\`\`\`\n`);
  s = s.replace(/<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/gi, (_, t) => `\n${t}\n`);
  // タグ単位で一致させてから属性を取り出す（[^<>]* で次の < か > で止め、閉じないタグの繰り返しで三乗にならないようにする）
  s = s.replace(/<ri:user[^<>]*\/>/gi, (m) => {
    const a = /ri:account-id="([^"]*)"/.exec(m);
    return a ? `@${a[1]}` : m;
  });
  s = replaceAcLinks(s);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<h([1-6])[^<>]*>/gi, (_, n) => '\n' + '#'.repeat(Number(n)) + ' ');
  s = s.replace(/<li[^<>]*>/gi, '\n- ');
  s = s.replace(/<t[dh][^<>]*>/gi, ' | ');
  s = s.replace(/<\/tr>/gi, '\n');
  s = s.replace(/<\/?([a-z0-9:-]+)[^<>]*>/gi, (m, tag) => (BLOCK.test(tag) ? '\n' : ' '));
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
       .replace(/&#x?([0-9a-f]+);/gi, (m, c) => { try { return String.fromCodePoint(parseInt(c, m[2] === 'x' ? 16 : 10)); } catch { return m; } });
  s = trimLineEnds(s).replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

/** Jira の Atlassian Document Format (ADF) → テキスト */
export function adfToText(node, depth = 0) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((n) => adfToText(n, depth)).join('');
  const t = node.type;
  const kids = () => adfToText(node.content || [], depth + 1);
  switch (t) {
    case 'doc': return kids();
    case 'text': return node.text || '';
    case 'hardBreak': return '\n';
    case 'paragraph': return kids() + '\n\n';
    case 'heading': return '\n' + '#'.repeat(node.attrs?.level || 1) + ' ' + kids() + '\n';
    case 'bulletList': case 'orderedList': return kids();
    case 'listItem': return '- ' + kids().trim() + '\n';
    case 'codeBlock': return '\n```' + (node.attrs?.language || '') + '\n' + kids() + '\n```\n';
    case 'blockquote': return '> ' + kids().trim() + '\n';
    case 'table': return kids();
    case 'tableRow': return kids().trim() + '\n';
    case 'tableHeader': case 'tableCell': return ' | ' + kids().trim();
    case 'inlineCard': return node.attrs?.url || '';
    case 'mention': return '@' + (node.attrs?.text || node.attrs?.id || '');
    case 'mediaSingle': case 'media': return '[media]';
    default: return kids();
  }
}
