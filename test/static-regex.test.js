// static.js の正規表現が、改行・空白・@Get( の繰り返しで二乗時間にならないことと、
// 通常の検出結果が旧実装と変わらないことの確認。
// 旧実装（修正前の正規表現）をこのファイル内に写してあり、差分テストの基準にする。
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEndpoints, projectFacts } from '../src/analysis/static.js';
import { redactText } from '../src/util/redact.js';

const OLD_PATTERNS = [
  { re: /\b(?:app|router|api)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/g, fw: 'express' },
  { re: /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/g, fw: 'nest/spring' },
  { re: /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g, fw: 'fastapi/flask' },
  { re: /\b(?:r|router|mux)\.(?:HandleFunc|Handle)\s*\(\s*"([^"]+)"/g, fw: 'go' },
  { re: /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gm, fw: 'rails' },
];
const OLD_USER = /^\s*USER\s+(?!root)/mi;

/** 修正前の extractEndpoints（パターンだけ旧版。ループは現行と同じ） */
function oldExtract(docs, limit = 300) {
  const out = [];
  for (const d of docs) {
    if (d.kind !== 'code') continue;
    const lines = d.text.split('\n');
    for (const { re, fw } of OLD_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(d.text)) !== null) {
        const line = d.text.slice(0, m.index).split('\n').length;
        const method = (m[2] !== undefined ? m[1] : 'ANY').toUpperCase();
        const route = redactText(m[2] !== undefined ? m[2] : m[1]).text;
        out.push({ method, route, framework: fw, line,
          snippet: redactText((lines[line - 1] || '').trim().slice(0, 2000)).text.slice(0, 200) });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

const code = (text, path = 'a.js') => ({ kind: 'code', sourceId: 's', path, text });
const docker = (text) => ({ kind: 'code', sourceId: 's', path: 'Dockerfile', text });
const container = (text) => projectFacts([docker(text)]).find((f) => f.kind === 'container').detail;

function timeMs(fn) {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const SIZE = 200 * 1024;
const LIMIT_MS = 1000;
const slow = (name, fn) => test(name, { timeout: 120000 }, () => {
  const ms = timeMs(fn);
  assert.ok(ms < LIMIT_MS, `${ms.toFixed(0)}ms かかった(上限 ${LIMIT_MS}ms)`);
});

// --- 時間 ---------------------------------------------------------------
slow('extractEndpoints(rails): 改行だけの 200KB が速い', () => extractEndpoints([code('\n'.repeat(SIZE), 'routes.rb')]));
slow('extractEndpoints(nest): "@Get(" の繰り返し 200KB が速い', () => extractEndpoints([code('@Get('.repeat(SIZE / 5), 'a.ts')]));
slow('projectFacts(Dockerfile): 改行だけの 200KB が速い', () => projectFacts([docker('\n'.repeat(SIZE))]));

for (const [name, unit] of [
  ['空白だけ', ' '],
  ['改行と空白', '\n '],
  ['get \' の繰り返し', "get '"],
  ['USER の繰り返し', 'USER '],
  ['@Get( と空白', '@Get(  '],
]) {
  const text = unit.repeat(Math.ceil(SIZE / unit.length));
  slow(`extractEndpoints: ${name}(200KB)が速い`, () => extractEndpoints([code(text)]));
  slow(`projectFacts(Dockerfile): ${name}(200KB)が速い`, () => projectFacts([docker(text)]));
}

// --- 回帰（通常のサンプル） -------------------------------------------------
test('extractEndpoints: Express / Nest / Rails / Flask / Go の通常の検出は変わらない', () => {
  const docs = [
    code("app.get('/users', h);\nrouter.post(\"/login\", h);\n", 'a.js'),
    code("@Controller()\nclass C {\n  @Get('items')\n  list() {}\n  @Post()\n  add() {}\n}\n", 'a.ts'),
    code("Rails.application.routes.draw do\n  get '/health'\n    post \"/jobs\"\nend\n", 'routes.rb'),
    code("@app.get(\"/ping\")\ndef ping(): pass\n", 'a.py'),
    code('r.HandleFunc("/go", h)\n', 'a.go'),
  ];
  const got = extractEndpoints(docs).map((e) => [e.framework, e.method, e.route, e.line, e.snippet]);
  assert.deepEqual(got, [
    ['express', 'GET', '/users', 1, "app.get('/users', h);"],
    ['express', 'POST', '/login', 2, 'router.post("/login", h);'],
    ['nest/spring', 'GET', 'items', 3, "@Get('items')"],
    ['nest/spring', 'POST', '', 5, '@Post()'],
    ['rails', 'GET', '/health', 2, "get '/health'"],
    ['rails', 'POST', '/jobs', 3, 'post "/jobs"'],
    // 従来から `@app.get(` は express 側にも一致する（今回は挙動を変えない）
    ['express', 'GET', '/ping', 1, '@app.get("/ping")'],
    ['fastapi/flask', 'GET', '/ping', 1, '@app.get("/ping")'],
    ['go', 'ANY', '/go', 1, 'r.HandleFunc("/go", h)'],
  ]);
});

test('projectFacts(Dockerfile): USER の有無の判定は通常のサンプルで変わらない', () => {
  assert.match(container('FROM x\nUSER app\n'), /あり$/);
  assert.match(container('FROM x\n   user  app\n'), /あり$/);
  assert.match(container('FROM x\nUSER root\n'), /なし/);
  assert.match(container('FROM x\nRUN echo USER app\n'), /なし/);
  assert.match(container('FROM x\n\n\n\nUSER app\n'), /あり$/);
});

// --- 旧実装との差分 -------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TOKENS = ['\n', '\n', ' ', '\t', '\r', '@Get(', '@Post(', '@Put', 'get ', 'post ', 'delete\t', "'", '"', '`', ')', '(',
  'a', '/x', 'app.get(', 'router.', 'USER ', 'user\n', 'root', 'x', 'é'];
function gen(r) {
  const n = 1 + Math.floor(r() * 14);
  let s = '';
  for (let i = 0; i < n; i++) s += TOKENS[Math.floor(r() * TOKENS.length)];
  return s;
}

test('旧実装との差分: method・route・件数・USER 判定が 6 万件の乱数入力で一致する', () => {
  const r = rng(20261117);
  let compared = 0;
  for (let i = 0; i < 60000; i++) {
    const text = gen(r);
    const o = oldExtract([code(text)]).map((e) => [e.framework, e.method, e.route]);
    const n = extractEndpoints([code(text)]).map((e) => [e.framework, e.method, e.route]);
    assert.deepEqual(n, o, `エンドポイントが旧実装と不一致: ${JSON.stringify(text)}`);
    if (o.length) compared++;
    const oldRoot = !OLD_USER.test(text);
    assert.equal(container(text).includes('なし'), oldRoot, `USER 判定が旧実装と不一致: ${JSON.stringify(text)}`);
  }
  assert.ok(compared > 500, `検出が 1 件以上ある入力が少なすぎる: ${compared}`);
});

test('line・snippet: 空行をまたがない場合は旧実装と一致し、またぐ場合は実際の行になる', () => {
  const r = rng(77);
  let swallowed = 0;
  let same = 0;
  for (let i = 0; i < 60000; i++) {
    const text = gen(r);
    const lines = text.split('\n');
    const o = oldExtract([code(text)]);
    const n = extractEndpoints([code(text)]);
    assert.equal(n.length, o.length);
    for (let k = 0; k < o.length; k++) {
      if (n[k].line === o[k].line) {
        same++;
        assert.equal(n[k].snippet, o[k].snippet, `snippet: ${JSON.stringify(text)}`);
      } else {
        // 旧実装は先行する空行（\r だけの区切りも含む）を取り込み、手前の行を指していた。新実装はマッチした行そのもの
        swallowed++;
        assert.ok(n[k].line > o[k].line, `line が進まない: ${JSON.stringify(text)}`);
        const actual = redactText((lines[n[k].line - 1] || '').trim().slice(0, 2000)).text.slice(0, 200);
        assert.equal(n[k].snippet, actual);
        assert.notEqual(n[k].snippet, '');
      }
    }
  }
  assert.ok(swallowed >= 10 && same > 500, `ケースが足りない: swallowed=${swallowed} same=${same}`);
});

test('line・snippet(具体例): 先行空行つきの rails 行は実際の行を指す', () => {
  const [e] = extractEndpoints([code("x\n\n\n  get '/a'\n", 'routes.rb')]);
  assert.equal(e.line, 4);
  assert.equal(e.snippet, "get '/a'");
});
