// LLM を使わない決定的ルール群。
// ここで出る指摘は「どのモデルを使っても必ず出る」ため、回答品質の下限を作る。
// 各ルールは行番号を返し、そのまま一次資料の引用（証拠）になる。

const anyCode = ['js','mjs','cjs','jsx','ts','tsx','py','rb','go','java','kt','php','cs','rs','scala','swift','sh','bash'];

export const RULES = [
  // ---- 秘密情報 -------------------------------------------------------
  { id: 'SEC-SECRET-PRIVATE-KEY', severity: 'critical', category: 'secret', cwe: 'CWE-798',
    title: '秘密鍵がリポジトリに含まれている',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'SEC-SECRET-AWS-AKID', severity: 'critical', category: 'secret', cwe: 'CWE-798',
    title: 'AWS アクセスキー ID らしき文字列', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'SEC-SECRET-GH-TOKEN', severity: 'critical', category: 'secret', cwe: 'CWE-798',
    title: 'GitHub トークンらしき文字列', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { id: 'SEC-SECRET-SLACK', severity: 'high', category: 'secret', cwe: 'CWE-798',
    title: 'Slack トークンらしき文字列', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'SEC-SECRET-GENERIC', severity: 'high', category: 'secret', cwe: 'CWE-798',
    title: 'ハードコードされた認証情報の可能性',
    re: /\b(?:api[_-]?key|access[_-]?key|client[_-]?secret|[a-z_]*secret|[a-z_]*token|passwd|password|credential|key)\s*[:=]\s*["'][^"'\s${}]{12,}["']/i,
    ignore: /(process\.env|os\.environ|getenv|System\.getenv|\$\{|<%|例|sample|example|dummy|placeholder|xxx|changeme|your[_-]?)/i },

  // ---- インジェクション ------------------------------------------------
  { id: 'SEC-EVAL', severity: 'high', category: 'injection', cwe: 'CWE-95',
    title: '動的コード実行 (eval / new Function)',
    re: /\b(?:eval\s*\(|new\s+Function\s*\(|vm\.runInNewContext\s*\()/, langs: ['js','mjs','cjs','jsx','ts','tsx'] },
  { id: 'SEC-EXEC-SHELL', severity: 'high', category: 'injection', cwe: 'CWE-78',
    title: 'シェル経由のコマンド実行（入力連結に注意）',
    re: /\b(?:child_process\.)?exec(?:Sync)?\s*\(|\bshell\s*=\s*True|\bRuntime\.getRuntime\(\)\.exec\(|\bos\.system\s*\(/ },
  { id: 'SEC-SQL-CONCAT', severity: 'high', category: 'injection', cwe: 'CWE-89',
    title: '文字列連結による SQL 組み立て',
    re: /(?:SELECT|INSERT|UPDATE|DELETE)\b[^\n;]{0,200}(?:\+\s*(?:req|params|query|body|input|user|id)\b|\$\{[^}]+\}|%s['"]?\s*%|f["'][^"']*\{)/i },
  { id: 'SEC-XSS-DANGEROUS-HTML', severity: 'high', category: 'injection', cwe: 'CWE-79',
    title: '未サニタイズの HTML 挿入',
    re: /dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\(|v-html\s*=/ },
  { id: 'SEC-PATH-TRAVERSAL', severity: 'medium', category: 'injection', cwe: 'CWE-22',
    title: '外部入力を含むパス結合',
    re: /(?:path\.join|path\.resolve|os\.path\.join|readFile(?:Sync)?|open)\s*\([^)\n]{0,120}\b(?:req\.(?:query|params|body)|request\.(?:args|form)|params\[)/ },
  { id: 'SEC-DESERIALIZE', severity: 'high', category: 'injection', cwe: 'CWE-502',
    title: '安全でないデシリアライズ',
    re: /\b(?:pickle\.loads?|yaml\.load\s*\((?![^)]*Safe)|unserialize\s*\(|ObjectInputStream)/ },

  // ---- 認証・認可・暗号 ------------------------------------------------
  { id: 'SEC-TLS-DISABLED', severity: 'critical', category: 'transport', cwe: 'CWE-295',
    title: 'TLS 検証の無効化',
    re: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|curl.*(?:-k\b|--insecure)/ },
  { id: 'SEC-WEAK-HASH', severity: 'medium', category: 'crypto', cwe: 'CWE-327',
    title: '脆弱なハッシュアルゴリズム (MD5 / SHA-1)',
    re: /createHash\s*\(\s*['"](?:md5|sha1)['"]|hashlib\.(?:md5|sha1)\s*\(|MessageDigest\.getInstance\s*\(\s*"(?:MD5|SHA-1)"/i },
  { id: 'SEC-WEAK-RANDOM', severity: 'medium', category: 'crypto', cwe: 'CWE-338',
    title: '暗号用途に不適な乱数',
    re: /(?:token|secret|nonce|salt|otp|session|password)[^\n=]{0,30}=\s*[^\n]{0,40}(?:Math\.random\s*\(|random\.random\s*\(|rand\s*\()/i },
  { id: 'SEC-JWT-NOVERIFY', severity: 'critical', category: 'authn', cwe: 'CWE-347',
    title: 'JWT の署名検証を省略',
    re: /jwt\.decode\s*\((?![^)]*verify)|verify\s*:\s*false|algorithms?\s*:\s*\[?\s*['"]none['"]/i },
  { id: 'SEC-CORS-WILDCARD', severity: 'medium', category: 'authz', cwe: 'CWE-942',
    title: 'CORS が全オリジン許可',
    re: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]|origin\s*:\s*['"]\*['"]|cors\(\s*\)/ },
  { id: 'SEC-COOKIE-INSECURE', severity: 'medium', category: 'session', cwe: 'CWE-614',
    title: 'Cookie に secure / httpOnly が無い',
    re: /(?:res\.cookie|set_cookie|setCookie)\s*\([^)]{0,200}\)/,
    post: (m) => !/httpOnly\s*:\s*true/i.test(m) || !/secure\s*:\s*true/i.test(m) },

  // ---- 信頼性・保守性 ---------------------------------------------------
  { id: 'REL-EMPTY-CATCH', severity: 'medium', category: 'reliability',
    title: '例外の握り潰し', re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}|except[^\n:]*:\s*pass\b/ },
  { id: 'REL-AWAIT-IN-LOOP', severity: 'low', category: 'performance',
    title: 'ループ内の await（N+1 の兆候）',
    re: /for\s*\([^)]*\)\s*\{[^}]{0,200}await\s|forEach\s*\(\s*async/ },
  { id: 'REL-NO-TIMEOUT', severity: 'low', category: 'reliability',
    title: 'HTTP 呼び出しにタイムアウト指定が無い',
    re: /\b(?:fetch|axios\.(?:get|post|put|delete)|requests\.(?:get|post))\s*\([^)]{0,200}\)/,
    post: (m) => !/timeout|signal|AbortController/i.test(m) },
  { id: 'REL-TODO', severity: 'info', category: 'debt',
    title: '未完了マーカー (TODO/FIXME/HACK/XXX)',
    re: /\b(?:TODO|FIXME|HACK|XXX)\b[:\s]/ },
  { id: 'REL-DEBUG-LEFTOVER', severity: 'low', category: 'debt',
    title: 'デバッグ出力の残存',
    re: /\b(?:console\.(?:log|debug)|print\s*\(|debugger;|binding\.pry|System\.out\.println)/ },
  { id: 'REL-TS-ANY', severity: 'info', category: 'debt',
    title: 'TypeScript の any / @ts-ignore',
    re: /:\s*any\b|@ts-ignore|@ts-nocheck/, langs: ['ts','tsx'] },
];

import { redactText } from '../util/redact.js';

const IGNORE_PATH = /(?:^|\/)(?:test|tests|__tests__|spec|fixtures?|mocks?|examples?|docs?)\//i;

/** 1 ドキュメント（コード/設定）に全ルールを適用 */
export function scanDocument(doc, { includeTestPaths = false, minSeverity = 'info' } = {}) {
  if (!['code', 'config'].includes(doc.kind)) return [];
  if (!includeTestPaths && IGNORE_PATH.test(doc.path)) return [];
  const order = ['info', 'low', 'medium', 'high', 'critical'];
  const minIdx = order.indexOf(minSeverity);
  const lines = doc.text.split('\n');
  const out = [];
  for (const rule of RULES) {
    if (order.indexOf(rule.severity) < minIdx) continue;
    if (rule.langs && !rule.langs.includes(doc.lang)) continue;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 4000) continue;
      const m = rule.re.exec(line);
      rule.re.lastIndex = 0;
      if (!m) continue;
      if (rule.ignore && rule.ignore.test(line)) continue;
      if (rule.post) {
        const window = lines.slice(i, Math.min(lines.length, i + 6)).join('\n');
        if (!rule.post(window)) continue;
      }
      out.push({
        ruleId: rule.id, severity: rule.severity, category: rule.category, cwe: rule.cwe || null,
        title: rule.title, sourceId: doc.sourceId, path: doc.path, line: i + 1,
        // 検出行そのものに秘密が載るため、外に出す表現は必ず墨消しする
        snippet: redactText(line.trim().slice(0, 300)).text,
        context: redactText(lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n')).text,
        url: doc.url && doc.sourceType === 'github' ? `${doc.url}#L${i + 1}` : doc.url,
      });
      if (out.filter((o) => o.ruleId === rule.id && o.path === doc.path).length >= 20) break;
    }
  }
  return out;
}

export const ANY_CODE_LANGS = anyCode;
