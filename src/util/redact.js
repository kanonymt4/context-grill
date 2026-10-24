// シークレット墨消し。
// 機密ファイル自体は index 対象から除外するが、通常のコード内に
// 埋め込まれた認証情報が LLM や外部埋め込み API に渡るのを防ぐ多層防御。
// 行数を変えない（= コードの行番号と引用検証の整合を保つ）ことが必須要件。

const PLACEHOLDER = /^(?:\$\{|<|%|process\.env|os\.environ|ENV\[|System\.getenv|getenv|null|undefined|true|false|xxx+|your[_-]?|change[_-]?me|example|sample|dummy|placeholder|redacted|\*+)$/i;

const RULES = [
  { kind: 'AWS_ACCESS_KEY', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}\b/g },
  { kind: 'GITHUB_TOKEN', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'SLACK_TOKEN', re: /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'STRIPE_KEY', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { kind: 'ANTHROPIC_KEY', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'OPENAI_KEY', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // 先頭の条件を \b でなく否定後読みにするのは、`-eyJ` の繰り返しで開始位置ごとに長い走査が走る三乗級の遅さを避けるため
  // （`-` を直前に持つトークンは拾わない）
  { kind: 'JWT', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'SENDGRID_KEY', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'NPM_TOKEN', re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  // URL に埋め込まれたパスワード（DB 接続文字列など）。スキーム名に上限（32 字）を付けるのは、区切りのない長い 1 行での二乗バックトラックを防ぐため
  { kind: 'URL_PASSWORD', re: /([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+):([^\s/:@]{3,})@/gi, replace: (m, a) => `${a}:«REDACTED:URL_PASSWORD»@` },
  // Authorization ヘッダ。空白の繰り返しは {0,8} に抑える（重なる \s* は長い空白の行で二乗時間になる）
  { kind: 'AUTH_HEADER', re: /((?:authorization|proxy-authorization)["']?\s{0,8}[:=]\s{0,8}["']?\s{0,8}(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi, replace: (m, a) => `${a}«REDACTED:AUTH_HEADER»` },
  // 引用符付きのハードコード認証情報（key = "..."）
  {
    kind: 'CREDENTIAL',
    re: /((?:pass(?:wo?rd)?|passwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|credential|token)["']?\s*[:=>]{1,2}\s*)(["'`])([^"'`\n]{6,})\2/gi,
    replace: (m, head, q, val) => (PLACEHOLDER.test(val.trim()) || /^\$\{|^process\.env|^os\.environ|^<%/.test(val.trim()) ? m : `${head}${q}«REDACTED:CREDENTIAL»${q}`),
  },
  // 行頭から始まる key=value / key: value（.env / properties / YAML / docker-compose の `- KEY=value` / `X-Api-Key: value` ヘッダ）。
  // キーはキーワードだけでもよく、`.` や `-` を含んでよい。キーワードの後に英数字が続くキー（password_hash など）は対象外。
  // 行頭の空白は [^\S\r\u2028\u2029]（行終端を除く空白）にする。m フラグでは \r の直後も行頭なので、\s* だと \r の繰り返しで二乗時間になる。
  {
    kind: 'ENV_ASSIGNMENT',
    re: /^([^\S\r\u2028\u2029]*(?:-[^\S\r\u2028\u2029]+)?(?:export\s+)?[A-Za-z0-9_.-]*?(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API[_-]KEY|ACCESS[_-]KEY|PRIVATE[_-]KEY|CREDENTIALS?)\s*[:=]\s*)(\S{6,})$/gim,
    replace: (m, head, val) => (PLACEHOLDER.test(val.trim()) ? m : `${head}«REDACTED:CREDENTIAL»`),
  },
  // 行の途中にある X-Api-Key ヘッダ（curl -H "X-Api-Key: ..." など。行頭のものは上の規則が処理する）
  { kind: 'AUTH_HEADER', re: /(\bx-api-key["']?\s{0,8}[:=]\s{0,8}["']?)([A-Za-z0-9._~+/=-]{8,})/gi, replace: (m, a, val) => (PLACEHOLDER.test(val) ? m : `${a}«REDACTED:AUTH_HEADER»`) },
  // .netrc 形式
  { kind: 'NETRC', re: /(\bpassword\s+)(\S{4,})/gi, replace: (m, head, val) => (PLACEHOLDER.test(val) ? m : `${head}«REDACTED:CREDENTIAL»`) },
];

const PEM_BEGIN = /-----BEGIN (?:[A-Z ]*)?(?:PRIVATE KEY|RSA PRIVATE KEY|OPENSSH PRIVATE KEY|PGP PRIVATE KEY BLOCK|CERTIFICATE)-----/;
const PEM_END = /-----END /;
const PEM_BEGIN_G = new RegExp(PEM_BEGIN.source, 'g');
const PEM_MARK = '«REDACTED:PRIVATE_KEY»';

/**
 * 1 行の中に BEGIN〜END が同居している PEM（JSON やコードの文字列リテラル。改行は `\n` のエスケープ）を置換する。
 * END が見つからない BEGIN は置換せず、`open` で「以降の行が鍵の本文」であることを伝える。
 * END の探索は indexOf で行う（END の無い BEGIN が並ぶ行で、正規表現の遅延量指定子による二乗時間を避ける）。
 * @returns {{line: string, found: boolean, open: boolean}}
 */
function redactInlinePem(line) {
  let found = false;
  let out = '';
  let pos = 0;
  PEM_BEGIN_G.lastIndex = 0;
  for (;;) {
    PEM_BEGIN_G.lastIndex = pos;
    const m = PEM_BEGIN_G.exec(line);
    if (!m) return { line: found ? out + line.slice(pos) : line, found, open: false };
    found = true;
    const afterBegin = m.index + m[0].length;
    const endAt = line.indexOf('-----END ', afterBegin);
    if (endAt < 0) return { line: out + line.slice(pos), found, open: true };
    const close = line.indexOf('-----', endAt + 9);
    const endTo = close < 0 ? line.length : close + 5;
    out += line.slice(pos, m.index) + PEM_MARK;
    pos = endTo;
  }
}

/**
 * @returns {{text: string, count: number, kinds: string[]}} 行数は入力と必ず一致する
 */
export function redactText(input) {
  if (!input) return { text: input ?? '', count: 0, kinds: [] };
  const lines = String(input).split('\n');
  const kinds = new Set();
  let count = 0;
  let inPem = false;

  const out = lines.map((line) => {
    let l = line;
    if (!inPem && PEM_BEGIN.test(line)) {
      const pem = redactInlinePem(line);
      kinds.add('PRIVATE_KEY'); count++;
      // END が同じ行にあれば、その行の中で置換して以降の行へは影響させない
      if (pem.open) { inPem = true; return pem.line; }
      l = pem.line;
    } else if (inPem) {
      if (PEM_END.test(line)) { inPem = false; return line; }
      return PEM_MARK;
    }
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      l = l.replace(rule.re, (...args) => {
        const replaced = rule.replace ? rule.replace(...args) : `«REDACTED:${rule.kind}»`;
        if (replaced !== args[0]) { kinds.add(rule.kind); count++; }
        return replaced;
      });
    }
    return l;
  });
  return { text: out.join('\n'), count, kinds: [...kinds] };
}

/** ログ・エラーメッセージ用。行数を保つ必要がないので環境変数の実値も落とす。 */
export function redactMessage(message, extraSecrets = []) {
  let s = String(message ?? '');
  for (const v of extraSecrets) {
    if (v && typeof v === 'string' && v.length >= 8) s = s.split(v).join('«REDACTED»');
  }
  // 実行時の環境変数値（トークン類）が混入していたら落とす
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 12) continue;
    if (!/TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|BEARER/i.test(k)) continue;
    if (s.includes(v)) s = s.split(v).join(`«REDACTED:${k}»`);
  }
  return redactText(s).text;
}
