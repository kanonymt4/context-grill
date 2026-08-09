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
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'SENDGRID_KEY', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'NPM_TOKEN', re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  // URL に埋め込まれたパスワード（DB 接続文字列など）
  { kind: 'URL_PASSWORD', re: /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s/:@]{3,})@/gi, replace: (m, a) => `${a}:«REDACTED:URL_PASSWORD»@` },
  // Authorization ヘッダ
  { kind: 'AUTH_HEADER', re: /((?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?\s*(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi, replace: (m, a) => `${a}«REDACTED:AUTH_HEADER»` },
  // 引用符付きのハードコード認証情報（key = "..."）
  {
    kind: 'CREDENTIAL',
    re: /((?:pass(?:wo?rd)?|passwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key|credential|token)["']?\s*[:=>]{1,2}\s*)(["'`])([^"'`\n]{6,})\2/gi,
    replace: (m, head, q, val) => (PLACEHOLDER.test(val.trim()) || /^\$\{|^process\.env|^os\.environ|^<%/.test(val.trim()) ? m : `${head}${q}«REDACTED:CREDENTIAL»${q}`),
  },
  // .env / properties 形式（引用符なし）
  {
    kind: 'ENV_ASSIGNMENT',
    re: /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)\s*=\s*)(\S{6,})$/gim,
    replace: (m, head, val) => (PLACEHOLDER.test(val.trim()) ? m : `${head}«REDACTED:CREDENTIAL»`),
  },
  // .netrc 形式
  { kind: 'NETRC', re: /(\bpassword\s+)(\S{4,})/gi, replace: (m, head, val) => (PLACEHOLDER.test(val) ? m : `${head}«REDACTED:CREDENTIAL»`) },
];

const PEM_BEGIN = /-----BEGIN (?:[A-Z ]*)?(?:PRIVATE KEY|RSA PRIVATE KEY|OPENSSH PRIVATE KEY|PGP PRIVATE KEY BLOCK|CERTIFICATE)-----/;
const PEM_END = /-----END /;

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
    if (PEM_BEGIN.test(line)) { inPem = true; kinds.add('PRIVATE_KEY'); count++; return line; }
    if (inPem) {
      if (PEM_END.test(line)) { inPem = false; return line; }
      return '«REDACTED:PRIVATE_KEY»';
    }
    let l = line;
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
    if (!/TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION/i.test(k)) continue;
    if (s.includes(v)) s = s.split(v).join(`«REDACTED:${k}»`);
  }
  return redactText(s).text;
}
