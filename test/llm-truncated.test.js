import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// LLM の出力が llm.maxOutputTokens で打ち切られたとき（stopReason が length / max_tokens）、
// 同じ上限での再送（修復ループ）を打ち切り、原因と対処をレポートとログに出す。
// 子プロセスで CLI を実行し、127.0.0.1 のダミー LLM サーバーに接続する。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'context-grill.js');
const KEY_ENV = 'CG_TRUNC_TEST_LLM_KEY';
const SOURCES = [{ id: 'proj', type: 'local', path: 'proj', include: ['**/*'], includeUnknownTypes: true }];

let tmp;
let server;
let calls = 0;
let mode = 'openai-length';
const cfgs = {};

// 途中で切れた JSON（閉じ括弧が無い）
const TRUNCATED = '{"summary":"timeout retry の調査","items":[{"id":"I1","type":"fact","title":"途中で切れ';

function respond(res, body) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CONTEXT_GRILL_LOG_LEVEL']) delete env[k];
  env[KEY_ENV] = 'dummy-key';
  return env;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: tmp, env: cleanEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-trunc-'));
  await fsp.mkdir(path.join(tmp, 'proj'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'proj', 'handler.js'), 'export function handler() { /* timeout retry */ return "timeout-retry"; }\n');

  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      const usage = { prompt_tokens: 10, completion_tokens: 8000 };
      if (mode === 'openai-length') {
        respond(res, { choices: [{ message: { content: TRUNCATED }, finish_reason: 'length' }], usage });
      } else if (mode === 'openai-stop-invalid') {
        // 打ち切りではないが、スキーマ違反（修復ループが回る）
        respond(res, { choices: [{ message: { content: '{"summary":"x"}' }, finish_reason: 'stop' }], usage });
      } else if (mode === 'anthropic-max-tokens') {
        respond(res, { content: [{ type: 'text', text: TRUNCATED }], stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 8000 } });
      } else {
        respond(res, { content: [{ type: 'text', text: '{"summary":"x"}' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const write = async (name, llm) => {
    const f = path.join(tmp, name);
    await fsp.writeFile(f, JSON.stringify({ project: 'x', sources: SOURCES, llm: { apiKeyEnv: KEY_ENV, baseUrl: `http://127.0.0.1:${port}`, model: 'm', ...llm } }));
    return f;
  };
  cfgs.openai = await write('openai.json', { provider: 'openai-compat', maxOutputTokens: 8000 });
  cfgs.anthropic = await write('anthropic.json', { provider: 'anthropic', maxOutputTokens: 8000 });
  const r = await run(['-c', cfgs.openai, 'sync', '--no-embed']);
  assert.equal(r.status, 0, `sync に失敗: ${r.stderr}`);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function ask(cfg, m) {
  calls = 0;
  mode = m;
  const r = await run(['ask', '「timeout」「retry」を調べて', '--json', '-c', cfg]);
  assert.equal(r.status, 0, r.stderr.slice(0, 400));
  return { r, out: JSON.parse(r.stdout) };
}

async function askMarkdown(cfg, m) {
  calls = 0;
  mode = m;
  const r = await run(['ask', '「timeout」「retry」を調べて', '-c', cfg]);
  assert.equal(r.status, 0, r.stderr.slice(0, 400));
  return r;
}

test('openai-compat: finish_reason=length で LLM 呼び出しは 1 回で止まり、meta.truncated が立つ', async () => {
  const { r, out } = await ask(cfgs.openai, 'openai-length');
  assert.equal(calls, 1, `LLM 呼び出し回数: ${calls}`);
  assert.equal(out.meta.truncated, true);
  assert.equal(out.meta.repairs, 0);
  assert.equal(out.meta.usage.output, 8000);
  assert.match(r.stderr, /maxOutputTokens/);
  assert.match(r.stderr, /8000/);
});

test('anthropic: stop_reason=max_tokens でも 1 回で止まり、meta.truncated が立つ', async () => {
  const { r, out } = await ask(cfgs.anthropic, 'anthropic-max-tokens');
  assert.equal(calls, 1, `LLM 呼び出し回数: ${calls}`);
  assert.equal(out.meta.truncated, true);
  assert.match(r.stderr, /maxOutputTokens/);
});

test('レポートの警告欄に、打ち切りと対処（maxOutputTokens）が出る', async () => {
  const r = await askMarkdown(cfgs.openai, 'openai-length');
  assert.equal(calls, 1);
  assert.match(r.stdout, /出力上限（llm\.maxOutputTokens=8000）で打ち切られ/);
});

test('対照: stop でスキーマ違反なら、従来どおり修復ループが回る（3 回）。truncated は立たない', async () => {
  const { out } = await ask(cfgs.openai, 'openai-stop-invalid');
  assert.equal(calls, 3, `LLM 呼び出し回数: ${calls}`);
  assert.equal(out.meta.repairs, 2);
  assert.ok(!out.meta.truncated);
  const r = await askMarkdown(cfgs.openai, 'openai-stop-invalid');
  assert.ok(!r.stdout.includes('打ち切られ'));
});

test('対照: anthropic の end_turn で違反があっても従来どおり 3 回', async () => {
  const { out } = await ask(cfgs.anthropic, 'anthropic-end-turn-invalid');
  assert.equal(calls, 3, `LLM 呼び出し回数: ${calls}`);
  assert.ok(!out.meta.truncated);
});
