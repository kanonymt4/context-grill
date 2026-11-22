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

/** re（g フラグ）を pos 以降で 1 回だけ実行する */
function execFrom(re, s, pos) {
  re.lastIndex = pos;
  return re.exec(s);
}

/**
 * <ac:plain-text-body><![CDATA[…]]></ac:plain-text-body> を fn(本文) の結果にする。
 * 正規表現（[\s\S]*? を含む）だと、閉じない開きの繰り返しで開始位置ごとに末尾まで走査して二乗になる。
 * 閉じが見つからなければ以降のどの開きにも閉じは無いので、そこで打ち切って線形にする。
 */
function replacePlainTextBodies(s, fn) {
  const open = /<ac:plain-text-body>\s*<!\[CDATA\[/gi;
  const close = /\]\]>\s*<\/ac:plain-text-body>/gi;
  let out = '';
  let pos = 0;
  for (;;) {
    const o = execFrom(open, s, pos);
    if (!o) break;
    const bodyStart = o.index + o[0].length;
    const c = execFrom(close, s, bodyStart);
    if (!c) break;
    out += s.slice(pos, o.index) + fn(s.slice(bodyStart, c.index));
    pos = c.index + c[0].length;
  }
  return out + s.slice(pos);
}

/**
 * <ac:structured-macro … ac:name="code" …> … <ac:plain-text-body><![CDATA[コード]]></ac:plain-text-body> … </ac:structured-macro>
 * を fn(コード) の結果にする。開き・name 属性・本文・閉じを位置の単調な走査で順に探し、全体を線形にする。
 * 開きの属性部分は、元の正規表現（[^>]*）と同じく、次の > より前までに限る。
 */
function replaceCodeMacros(s, fn) {
  const open = /<ac:structured-macro/gi;
  const name = /ac:name="code"/gi;
  const body = /<ac:plain-text-body>\s*<!\[CDATA\[/gi;
  const bodyEnd = /\]\]>\s*<\/ac:plain-text-body>/gi;
  const close = /<\/ac:structured-macro>/gi;
  let out = '';
  let pos = 0;
  let scan = 0;
  // 次の > と name 属性の位置は、開きが前へ進むだけなので、前回の結果が使えるうちは再探索しない
  let gt = -2;
  let nm;
  for (;;) {
    const o = execFrom(open, s, scan);
    if (!o) break;
    const attrStart = o.index + o[0].length;
    scan = attrStart;
    if (gt !== -1 && gt < attrStart) gt = s.indexOf('>', attrStart);
    const attrEnd = gt === -1 ? s.length : gt;
    if (nm === undefined || (nm && nm.index < attrStart)) nm = execFrom(name, s, attrStart);
    if (!nm || nm.index + nm[0].length > attrEnd) continue;
    const b = execFrom(body, s, nm.index + nm[0].length);
    if (!b) break;
    const codeStart = b.index + b[0].length;
    const e = execFrom(bodyEnd, s, codeStart);
    if (!e) break;
    const c = execFrom(close, s, e.index + e[0].length);
    if (!c) break;
    out += s.slice(pos, o.index) + fn(s.slice(codeStart, e.index));
    pos = scan = c.index + c[0].length;
  }
  return out + s.slice(pos);
}

/** <![CDATA[…]]> を中身だけにする（閉じが無ければ以降は何もしない） */
function unwrapCdata(s) {
  let out = '';
  let pos = 0;
  for (;;) {
    const o = s.indexOf('<![CDATA[', pos);
    if (o === -1) break;
    const c = s.indexOf(']]>', o + 9);
    if (c === -1) break;
    out += s.slice(pos, o) + s.slice(o + 9, c);
    pos = c + 3;
  }
  return out + s.slice(pos);
}

/**
 * <script>…</script> と <style>…</style> を空白 1 つにする（大文字小文字は区別しない）。
 * タグごとに、閉じが見つからなければ以降の同じタグの開きも打ち切る（もう一方のタグは続ける）。
 */
function removeScriptStyle(s) {
  const open = /<(script|style)/gi;
  const closes = { script: /<\/script>/gi, style: /<\/style>/gi };
  const dead = { script: false, style: false };
  let out = '';
  let pos = 0;
  let scan = 0;
  for (;;) {
    const o = execFrom(open, s, scan);
    if (!o) break;
    scan = o.index + o[0].length;
    const tag = o[1].toLowerCase();
    if (dead[tag]) continue;
    const c = execFrom(closes[tag], s, scan);
    if (!c) { dead[tag] = true; continue; }
    out += s.slice(pos, o.index) + ' ';
    pos = scan = c.index + c[0].length;
  }
  return out + s.slice(pos);
}

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  larr: '←', rarr: '→', times: '×', le: '≤', ge: '≥', ne: '≠',
  yen: '¥', copy: '©', reg: '®', trade: '™', middot: '·',
  laquo: '«', raquo: '»',
};

/**
 * 実体参照を 1 回の走査で復号する（復号結果は再走査しないので、&amp;lt; は &lt; になる）。
 * 表に無い名前・範囲外の数値・退避用の番兵に使う U+E000 / U+E001 は、そのまま残す。
 */
function decodeEntities(s) {
  return s.replace(/&(?:#([xX][0-9a-fA-F]+|[0-9]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (m, num, name) => {
    if (name !== undefined) return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m;
    const cp = num[0] === 'x' || num[0] === 'X' ? parseInt(num.slice(1), 16) : parseInt(num, 10);
    if (cp === 0xE000 || cp === 0xE001 || !(cp > 0 && cp <= 0x10FFFF)) return m;
    return String.fromCodePoint(cp);
  });
}

/**
 * <pre>…</pre> を fn(中身) の結果にする。閉じが見つからなければ以降の開きにも閉じは無いので打ち切って線形にする。
 */
function replacePre(s, fn) {
  const open = /<pre(?=[\s>/])[^<>]*>/gi;
  const close = /<\/pre\s*>/gi;
  let out = '';
  let pos = 0;
  for (;;) {
    const o = execFrom(open, s, pos);
    if (!o) break;
    const bodyStart = o.index + o[0].length;
    const c = execFrom(close, s, bodyStart);
    if (!c) break;
    out += s.slice(pos, o.index) + fn(s.slice(bodyStart, c.index));
    pos = c.index + c[0].length;
  }
  return out + s.slice(pos);
}

/** <ri:user ri:account-id="…"/> を @… にし、<ac:link> を [[ページ名]] にする（タグ単位で一致させてから属性を取り出す） */
function convertMentionsAndLinks(s) {
  s = s.replace(/<ri:user[^<>]*\/>/gi, (m) => {
    const a = /ri:account-id="([^"]*)"/.exec(m);
    return a ? `@${a[1]}` : m;
  });
  return replaceAcLinks(s);
}

/**
 * <pre> の中身を、字下げを保ったままテキストにする。CDATA の中身はタグ除去・変換の対象にしない
 * （<![CDATA[a<b]]> の < を、タグの始まりと誤認しない）。CDATA の外では、<br> を改行にし、メンション・リンクを変換してからタグを除く。
 */
function preInnerToText(inner) {
  const plain = (t) => convertMentionsAndLinks(t).replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-z0-9:-]+[^<>]*>/gi, '');
  let out = '';
  let pos = 0;
  for (;;) {
    const o = inner.indexOf('<![CDATA[', pos);
    if (o === -1) break;
    const c = inner.indexOf(']]>', o + 9);
    if (c === -1) break;
    out += plain(inner.slice(pos, o)) + inner.slice(o + 9, c);
    pos = c + 3;
  }
  return out + plain(inner.slice(pos));
}

/**
 * htmlToText の変換規則の版。変換結果が変わる修正のたびに上げる
 * （Confluence の差分同期は、ページの版が同じならキャッシュ本文を使うので、この版も条件に含める）。
 */
export const HTML_TEXT_VERSION = 2;

/** Confluence storage format / 一般的な HTML をプレーンテキスト化（依存ゼロ） */
export function htmlToText(html) {
  if (!html) return '';
  // 退避用の番兵（U+E000 / U+E001）が本文にあると、復号後に番兵と一致して本文がコードに置き換わるので、先に取り除く
  let s = String(html).replace(/[]/g, '');
  // コード（コードマクロ・plain-text-body・<pre>）は、タグ除去・復号・空白の圧縮の対象から外すため番兵へ退避し、最後に戻す。
  // 番兵の接頭辞は、入力に現れない文字列を選ぶ（本文に似た文字列があっても壊れない）
  let prefix;
  for (let k = 0; ; k++) {
    prefix = `cg${k}_`;
    if (!s.includes(prefix)) break;
  }
  const stash = [];
  const keep = (text) => `${prefix}${stash.push(text) - 1}`;
  // コードマクロは fenced block として温存（仕様書内のコードは一次資料として重要）
  s = replaceCodeMacros(s, (code) => `\n\`\`\`\n${keep(decodeEntities(code))}\n\`\`\`\n`);
  s = replacePlainTextBodies(s, (t) => `\n${keep(decodeEntities(t))}\n`);
  s = replacePre(s, (inner) => `\n${keep(decodeEntities(preInnerToText(inner)))}\n`);
  // タグ単位で一致させてから属性を取り出す（[^<>]* で次の < か > で止め、閉じないタグの繰り返しで三乗にならないようにする）
  s = convertMentionsAndLinks(s);
  s = unwrapCdata(s);
  s = removeScriptStyle(s);
  s = s.replace(/<h([1-6])[^<>]*>/gi, (_, n) => '\n' + '#'.repeat(Number(n)) + ' ');
  s = s.replace(/<li[^<>]*>/gi, '\n- ');
  s = s.replace(/<t[dh][^<>]*>/gi, ' | ');
  s = s.replace(/<\/tr>/gi, '\n');
  s = s.replace(/<\/?([a-z0-9:-]+)[^<>]*>/gi, (m, tag) => (BLOCK.test(tag) ? '\n' : ' '));
  s = decodeEntities(s);
  s = trimLineEnds(s).replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
  // 退避したコードを戻す（1 回の置換で、戻した本文は再走査しない）
  if (stash.length) s = s.replace(new RegExp(`${prefix}(\\d+)`, 'g'), (m, i) => stash[Number(i)] ?? m);
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
