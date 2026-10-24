import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// CLI のフラグの扱い。打ち間違えたフラグが黙って無視され、押したつもりの安全側の指定
// （--dry-run / --offline）が効かないまま LLM に送信される、という問題を防ぐ。
// 子プロセスで CLI を実行し、一時ディレクトリの設定を -c で渡す（リポジトリ直下の .env を読ませない）。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'context-grill.js');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const KEY_ENV = 'CG_FLAGS_TEST_LLM_KEY';
const SOURCES = [{ id: 'proj', type: 'local', path: 'proj', include: ['**/*'], includeUnknownTypes: true }];

let tmp;              // 一時ディレクトリ（設定・資料・出力先）
let cfgDry;           // LLM は dry
let cfgLlm;           // LLM は anthropic（送信先はダミーサーバー）
let cfgRemote;        // github ソースを含む（privacy 用。通信はしない）
let server;
let received = [];    // ダミーサーバーが受けたリクエスト

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CONTEXT_GRILL_LOG_LEVEL', KEY_ENV]) delete env[k];
  return { ...env, ...extra };
}

/** CLI を非同期に実行する（ダミーサーバーを同じプロセスで動かすため spawnSync は使わない）。 */
function run(args, { cwd = tmp, env = cleanEnv() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-cli-flags-'));
  await fsp.mkdir(path.join(tmp, 'proj', 'tests'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'proj', 'handler.js'), 'export function handler() { /* timeout retry */ return "timeout-retry"; }\n');
  await fsp.writeFile(path.join(tmp, 'proj', 'tests', 'bad.js'), 'const agent = { rejectUnauthorized: false };\n');

  server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => { res.statusCode = 500; res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const write = async (name, body) => {
    const f = path.join(tmp, name);
    await fsp.writeFile(f, JSON.stringify({ project: 'x', sources: SOURCES, ...body }));
    return f;
  };
  cfgDry = await write('dry.json', { llm: { provider: 'dry', model: 'd' } });
  cfgLlm = await write('llm.json', {
    llm: { provider: 'anthropic', model: 'm', apiKeyEnv: KEY_ENV, baseUrl: `http://127.0.0.1:${port}` },
  });
  cfgRemote = await write('remote.json', {
    sources: [...SOURCES, { id: 'repo', type: 'github', repo: 'acme/api', ref: 'main', mode: 'clone' }],
    llm: { provider: 'dry', model: 'd' },
  });
  // 索引を作る（無いと「索引がありません」が本来の失敗理由を隠す）
  for (const cfg of [cfgDry, cfgLlm]) {
    const r = await run(['-c', cfg, 'sync', '--no-embed']);
    assert.equal(r.status, 0, `sync に失敗: ${r.stderr}`);
  }
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fsp.rm(tmp, { recursive: true, force: true });
});

// ------------------------------------------------- 打ち間違えたフラグ
const TYPOS = [
  [['ask', 'x', '--dryrun'], '--dryrun（--dry-run のことですか？）'],
  [['ask', 'x', '--dry_run'], '--dry_run（--dry-run のことですか？）'],
  [['ask', 'x', '--offine'], '--offine（--offline のことですか？）'],
  [['search', 'x', '--toop', '1'], '--toop（--top のことですか？）'],
  [['status', '--jsno'], '--jsno（--json のことですか？）'],
  [['scan', '--severty', 'high'], '--severty（--severity のことですか？）'],
];

for (const [args, expected] of TYPOS) {
  test(`未知のフラグ: ${args.join(' ')} は終了コード 1 で候補を出す`, async () => {
    const r = await run([...args, '-c', cfgDry]);
    assert.equal(r.status, 1, `stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`);
    assert.ok(r.stderr.includes(`未知のオプション: ${expected}`), r.stderr);
  });
}

test('未知のフラグ: 近い候補が無ければ候補なしで拒否する', async () => {
  const r = await run(['status', '--zzzzzzzz', '-c', cfgDry]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('未知のオプション: --zzzzzzzz'), r.stderr);
  assert.ok(!r.stderr.includes('のことですか'), r.stderr);
});

test('未知のフラグ: そのコマンドが読まないフラグも拒否する（status に --top）', async () => {
  const r = await run(['status', '--top', '3', '-c', cfgDry]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('未知のオプション: --top'), r.stderr);
});

test('--dry-run の打ち間違いでは LLM に送信されない（ダミーサーバーの受信 0 件）', async () => {
  received = [];
  const env = cleanEnv({ [KEY_ENV]: 'dummy-key' });
  for (const flag of ['--dryrun', '--dry_run', '--dryRn']) {
    const r = await run(['ask', '「timeout」「retry」を調べて', flag, '-c', cfgLlm], { env });
    assert.equal(r.status, 1, `${flag}: ${r.stderr.slice(0, 300)}`);
    assert.ok(r.stderr.includes('未知のオプション'), r.stderr);
  }
  assert.deepEqual(received, [], 'ダミーサーバーにリクエストが届いた');
});

test('--help のときは未知のフラグを検査しない', async () => {
  const r = await run(['ask', '--dryrun', '--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('使い方:'), r.stdout);
});

test('未知のコマンドは従来どおりエラー', async () => {
  const r = await run(['nosuch', '-c', cfgDry]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('未知のコマンド: nosuch'), r.stderr);
});

// ------------------------------------------------- 回帰ガード（正しいフラグは通る）
const VALID = [
  ['sync', '--full', '--no-embed', '--source', 'proj', '--json', '--log', 'warn'],
  ['sync', '--source=proj', '--no-embed', '--offline'],
  ['build', '--no-embed'],
  ['status', '--json'],
  ['search', 'retry', '-k', '3', '--raw', '--source', 'proj', '--json'],
  ['search', 'retry', '--top', '2', '--no-offline'],
  ['scan', '--severity', 'info', '--json'],
  ['ask', 'timeout の仕様', '--task', 'spec', '-e', 'low', '-m', 'foo', '--dry-run', '--source', 'proj', '--offline', '--json'],
  ['ask', 'timeout の仕様', '-t', 'bug', '--dryRun', '--out', 'out-ask.md'],
  ['tasks', '--json'],
  ['presets', '--json'],
  ['privacy', '--json', '--offline'],
  ['resolve', 'https://github.com/acme/api', '--id', 'x', '--json'],
];

for (const args of VALID) {
  test(`正しいフラグは通る: ${args.join(' ')}`, async () => {
    for (const tail of [['-c', cfgDry]]) {
      const r = await run([...args, ...tail]);
      assert.equal(r.status, 0, `stderr=${r.stderr.slice(0, 300)}`);
      assert.ok(!r.stderr.includes('未知のオプション'), r.stderr);
    }
  });
}

test('正しいフラグは通る: doctor --offline --json（未知のオプションにならない）', async () => {
  const r = await run(['doctor', '--offline', '--json', '-c', cfgDry]);
  assert.ok(!r.stderr.includes('未知のオプション'), r.stderr);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test('正しいフラグは通る: -c を先頭に置いても、--offline --log が先頭でも通る', async () => {
  const r = await run(['-c', cfgDry, '--offline', '--log', 'error', 'search', 'retry']);
  assert.equal(r.status, 0, r.stderr);
});

test('正しいフラグは通る: -- の後ろの位置引数はフラグとして検査されない', async () => {
  const r = await run(['search', '-c', cfgDry, '--', '--dryrun']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes('未知のオプション'), r.stderr);
});

test('正しいフラグは通る: init --dir --force', async () => {
  const dir = await fsp.mkdtemp(path.join(tmp, 'init-'));
  const r = await run(['init', '--dir', dir, '--force']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'context-grill.config.json')));
});

test('run: 既存の挙動は変えない（未知のフラグは run 専用のメッセージ、preset 名なしはそのエラー）', async () => {
  const r1 = await run(['run', 'nope', '--focus', 'x', '-c', cfgDry]);
  assert.equal(r1.status, 1);
  assert.ok(r1.stderr.includes('run では使えないオプション: --focus'), r1.stderr);
  const r2 = await run(['run', '--dry-run', '-c', cfgDry]);
  assert.equal(r2.status, 1);
  assert.ok(r2.stderr.includes('preset 名を指定してください'), r2.stderr);
});

// ------------------------------------------------- --version
for (const args of [['--version'], ['-v'], ['version']]) {
  test(`${args.join(' ')} は package.json の version を 1 行で出す`, async () => {
    const r = await run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${PKG.version}\n`);
  });
}

// ------------------------------------------------- --include-tests
test('scan: --include-tests と --includeTests の両方でテストパスが対象になり、無指定では対象外', async () => {
  const paths = async (extra) => {
    const r = await run(['scan', '--severity', 'info', '--json', ...extra, '-c', cfgDry]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).findings.map((f) => f.path);
  };
  assert.ok(!(await paths([])).some((p) => p.startsWith('tests/')), '無指定でテストパスが含まれた');
  assert.ok((await paths(['--include-tests'])).some((p) => p.startsWith('tests/')), '--include-tests');
  assert.ok((await paths(['--includeTests'])).some((p) => p.startsWith('tests/')), '--includeTests');
});

// ------------------------------------------------- --log
for (const bad of ['bogus', 'WARN', 'constructor', '__proto__']) {
  test(`--log ${bad} は終了コード 1`, async () => {
    const r = await run(['status', '--log', bad, '-c', cfgDry]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('--log には silent / error / warn / info / debug のいずれかを指定してください'), r.stderr);
  });
}

test('--log は run でも検査される', async () => {
  const r = await run(['run', 'x', '--log', 'WARN', '-c', cfgDry]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('--log には silent / error / warn / info / debug のいずれかを指定してください'), r.stderr);
});

for (const ok of ['silent', 'error', 'warn', 'info', 'debug']) {
  test(`--log ${ok} は通る`, async () => {
    const r = await run(['status', '--log', ok, '-c', cfgDry]);
    assert.equal(r.status, 0, r.stderr);
  });
}

test('log.js の setLevel: prototype のキー（constructor）では水準が変わらない', async () => {
  const code = `
    import { setLevel, log } from ${JSON.stringify(path.join(ROOT, 'src', 'util', 'log.js'))};
    setLevel('constructor');
    log.debug('DEBUG_VISIBLE');
  `;
  const r = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: tmp, env: cleanEnv() });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (status) => resolve({ status, err }));
  });
  assert.equal(r.status, 0, r.err);
  assert.ok(!r.err.includes('DEBUG_VISIBLE'), 'constructor で debug が出力された（水準が壊れた）');
});

// ------------------------------------------------- 空白だけの指示
for (const instruction of ['   ', '', ' \t ']) {
  test(`ask ${JSON.stringify(instruction)} は終了コード 1`, async () => {
    const r = await run(['ask', instruction, '--dry-run', '-c', cfgDry]);
    assert.equal(r.status, 1, r.stdout.slice(0, 200));
    assert.ok(/指示/.test(r.stderr), r.stderr);
  });
}

test('ask: 空白だけの指示のメッセージは「指示が空です」', async () => {
  const r = await run(['ask', '   ', '--dry-run', '-c', cfgDry]);
  assert.ok(r.stderr.includes('指示が空です'), r.stderr);
});

// ------------------------------------------------- privacy
test('privacy: local ソースだけなら「ソース取得」は送信なし、github があれば送信あり', async () => {
  const local = await run(['privacy', '-c', cfgDry]);
  assert.equal(local.status, 0, local.stderr);
  assert.ok(!/送信あり\s+ソース取得/.test(local.stdout), local.stdout);
  assert.ok(/送信なし\s+ソース取得（ローカルのみ）/.test(local.stdout), local.stdout);
  const localJson = JSON.parse((await run(['privacy', '--json', '-c', cfgDry])).stdout);
  assert.equal(localJson.outbound[0].enabled, false);

  const remote = await run(['privacy', '-c', cfgRemote]);
  assert.equal(remote.status, 0, remote.stderr);
  assert.ok(/送信あり\s+ソース取得 \(GitHub \/ Confluence \/ Jira\)/.test(remote.stdout), remote.stdout);
  const remoteJson = JSON.parse((await run(['privacy', '--json', '-c', cfgRemote])).stdout);
  assert.equal(remoteJson.outbound[0].enabled, true);
  assert.deepEqual(Object.keys(remoteJson.outbound[0]), Object.keys(localJson.outbound[0]), 'JSON の形が変わった');
});

// ------------------------------------------------- init の .env.example
test('init: .env.example は値と同じ行にコメントを置かない', async () => {
  const dir = await fsp.mkdtemp(path.join(tmp, 'init-env-'));
  const r = await run(['init', '--dir', dir]);
  assert.equal(r.status, 0, r.stderr);
  const lines = (await fsp.readFile(path.join(dir, '.env.example'), 'utf8')).split('\n');
  // 「KEY=値   # コメント」の形（コメントを外して値を足すと値にコメントが入る）が無いこと
  const bad = lines.filter((l) => /^#?\s*[A-Z][A-Z0-9_]*=.*\s#/.test(l));
  assert.deepEqual(bad, []);
  assert.ok(lines.some((l) => /^# VOYAGE_API_KEY=$/.test(l)), 'VOYAGE_API_KEY が無い');
  assert.ok(lines.some((l) => l.includes('fine-grained') && l.includes('Contents: Read-only')), 'GITHUB_TOKEN の説明が README と合っていない');
});
