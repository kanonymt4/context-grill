const BLOCK = /^(p|div|br|li|tr|h[1-6]|table|thead|tbody|section|article|pre|blockquote|ul|ol|dl|dt|dd)$/i;

/** Confluence storage format / 一般的な HTML をプレーンテキスト化（依存ゼロ） */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  // コードマクロは fenced block として温存（仕様書内のコードは一次資料として重要）
  s = s.replace(/<ac:structured-macro[^>]*ac:name="code"[\s\S]*?<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/gi,
    (_, code) => `\n\`\`\`\n${code}\n\`\`\`\n`);
  s = s.replace(/<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/gi, (_, t) => `\n${t}\n`);
  s = s.replace(/<ri:user[^>]*ri:account-id="([^"]*)"[^>]*\/>/gi, (_, id) => `@${id}`);
  s = s.replace(/<ac:link[^>]*>[\s\S]*?<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/>[\s\S]*?<\/ac:link>/gi, (_, t) => `[[${t}]]`);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(Number(n)) + ' ');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<t[dh][^>]*>/gi, ' | ');
  s = s.replace(/<\/tr>/gi, '\n');
  s = s.replace(/<\/?([a-z0-9:-]+)[^>]*>/gi, (m, tag) => (BLOCK.test(tag) ? '\n' : ' '));
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
       .replace(/&#x?([0-9a-f]+);/gi, (m, c) => { try { return String.fromCodePoint(parseInt(c, m[2] === 'x' ? 16 : 10)); } catch { return m; } });
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
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
