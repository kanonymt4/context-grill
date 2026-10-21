import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig, paths } from '../src/config.js';
import { syncSources, buildIndex } from '../src/index/ingest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** probe が IndexStore.open() 1 回につき stderr に出す印。 */
const OPEN_MARK = '__CONTEXT_GRILL_OPEN__';

/**
 * MCP サーバーを子プロセスで起動する。
 *
 * IndexStore.open() の呼び出し回数を数えたいので bin/ ではなく専用の probe を使う。
 * openCount / openHandles は fd の開閉を数えるカウンタで、IndexStore.open() 自体
 * （manifest / docs.meta / df / lens の JSON 読み込み）は fd を使わないため、
 * 既存カウンタでは二重オープンを検知できない。
 */
async function writeProbe(dir, configPath, { openDelayMs = 0 } = {}) {
  const probe = path.join(dir, 'probe.mjs');
  // 終了処理に依存せず、open() のたびに stderr へ印を出す。
  //
  // 最初は SIGTERM ハンドラで最後に集計値を出していたが、**Windows には SIGTERM が無く**、
  // child.kill('SIGTERM') はハンドラを走らせずにプロセスを強制終了するため、印が出ないまま
  // 終わっていた（windows-latest の 3 ジョブだけが「実際: null 回」で落ちた）。
  // 番兵行を stdin で送る案も駄目だった。**stdin は最初の 'data' リスナが付いた時点で流れ始める**ため、
  // probe 側でリスナを付けると、server が自分のリスナを付ける前に最初のチャンクを取りこぼす。
  // 出力側だけで完結させるのが唯一 OS にもタイミングにも依存しない形。
  await fsp.writeFile(probe, `
import { IndexStore } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/index/store.js')).href)};
const orig = IndexStore.open.bind(IndexStore);
let opens = 0;
IndexStore.open = async (d) => { opens++; process.stderr.write('\\n' + ${JSON.stringify(OPEN_MARK)} + '\\n'); const s = await orig(d); if (opens === 1 && ${Number(openDelayMs)} > 0) await new Promise((r) => setTimeout(r, ${Number(openDelayMs)})); return s; };
const { startMcpServer } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/mcp/server.js')).href)});
startMcpServer({ configPath: ${JSON.stringify(configPath)} });
`);
  return probe;
}

/** リクエスト行をまとめて 1 回の write で送り、指定件数の応答を待つ。 */
function rpc(probe, lines, expected, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe], { stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = [];
    let done = false;
    // opts.then を渡すと、最初の expected 件が返ってから第 2 チャンクを送る。
    // 「sync 完了後に改めて検索する」という並びを 1 プロセス内で作るために要る。
    let sentThen = false;
    const firstExpected = expected;
    let target = expected;
    let out = '';
    let errText = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('タイムアウト: ' + out + errText)); }, 20000);
    // チャンクの境界でマルチバイト文字が割れても壊れないよう、setEncoding で継ぎ直す
    // （Buffer を文字列に足すと U+FFFD になる）
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        try { responses.push(JSON.parse(line)); } catch { /* ignore */ }
      }
      // 応答が揃ったら停止する。SIGKILL はハンドラを介さないので Windows でも同じ挙動になる。
      // stderr が届き切るよう少しだけ待つ（印は応答より前に出ているので取りこぼしはない）。
      if (responses.length >= firstExpected && opts.then && !sentThen) {
        sentThen = true;
        target = firstExpected + (opts.thenExpected ?? opts.then.length);
        child.stdin.write(opts.then.map((l) => JSON.stringify(l)).join('\n') + '\n');
      }
      if (responses.length >= target && !done) {
        done = true;
        setTimeout(() => child.kill('SIGKILL'), 100);
      }
    });
    child.stderr.on('data', (c) => { errText += c; });
    child.on('close', () => {
      clearTimeout(timer);
      const opens = (errText.match(new RegExp(OPEN_MARK, 'g')) || []).length;
      resolve({ responses, opens, stderr: errText });
    });
    child.on('error', reject);
    // 1 チャンクにまとめて送る（server.js の stdin 'data' ハンドラは await されない）
    child.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
}

async function fixture({ build }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-mcp-'));
  await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'src', 'payment.js'),
    'const MAX_RETRY = 3;\nfunction refundPayment(id) { return id; }\nmodule.exports = { refundPayment, MAX_RETRY };\n');
  const configPath = path.join(dir, 'context-grill.config.json');
  await fsp.writeFile(configPath, JSON.stringify({
    project: 'mcp-test',
    sources: [{ id: 'repo', type: 'local', path: dir, include: ['src/**'] }],
    llm: { provider: 'dry', model: 'dry' },
  }));
  if (build) {
    const config = await loadConfig(configPath);
    await syncSources(config, {});
    await buildIndex(config, { embed: false });
  }
  return { dir, configPath };
}

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('MCP: 索引が無くても不正なタスク名は「未知のタスク」を返す（索引エラーより先に検証する）', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const { responses } = await rpc(probe, [call(1, 'context_grill_run_task', { instruction: 'x', task: 'nope' })], 1);
  const text = responses[0]?.result?.content?.[0]?.text ?? JSON.stringify(responses[0]);
  assert.match(text, /未知のタスク/, `索引の有無より先にタスク名を検証すべき。実際の応答: ${text}`);
});

test('MCP: 索引が無くても prototype のキーのタスク名（constructor）は「未知のタスク」を返す', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const { responses } = await rpc(probe, [call(1, 'context_grill_run_task', { instruction: 'x', task: 'constructor' })], 1);
  const text = responses[0]?.result?.content?.[0]?.text ?? JSON.stringify(responses[0]);
  assert.match(text, /未知のタスク/, `own のキーだけを受理すべき。実際の応答: ${text}`);
});

test('MCP: 同一チャンクの並行リクエストで IndexStore.open() が二重に走らない', async () => {
  const { dir, configPath } = await fixture({ build: true });
  const probe = await writeProbe(dir, configPath);
  const { responses, opens } = await rpc(probe, [
    call(1, 'context_grill_search', { query: 'refund' }),
    call(2, 'context_grill_search', { query: 'retry' }),
  ], 2);
  assert.equal(responses.length, 2, '2 件とも応答が返る');
  assert.equal(opens, 1, `キャッシュされたストアは 1 回だけ開かれるべき（実際: ${opens} 回）`);
});

test('MCP: evidence_pack も不正なタスク名で「未知のタスク」を返す', async () => {
  const { dir, configPath } = await fixture({ build: true });
  const probe = await writeProbe(dir, configPath);
  const { responses } = await rpc(probe, [call(1, 'context_grill_evidence_pack', { instruction: 'x', task: 'nope' })], 1);
  const text = responses[0]?.result?.content?.[0]?.text ?? JSON.stringify(responses[0]);
  assert.match(text, /未知のタスク/, `TASKS を直接引かず resolveTask で検証すべき。実際の応答: ${text}`);
});

/**
 * finding 3 の構造ガード。
 *
 * 「将来 getStore() を使うツールを追加したとき allowlist への登録を忘れる」という失敗は、
 * 現在のツール群には該当例が無いため実行時テストでは再現できない（登録漏れしている
 * ツールが今は存在しない）。そこで登録漏れが起こり得ない構造になっていること自体を
 * 表明する。ストア取得はリクエストスコープの getStore を引数で受け取る形に限定し、
 * 手動の allowlist を残さない。
 *
 * 注意: この表明はソース文字列に依存する。callTool のシグネチャや getStore の定義位置を
 * 変えたら、ここの正規表現も一緒に更新すること。**このテストが落ちたときは、まず実装では
 * なくこのテストを疑う。**
 */
test('MCP: ストア保護が手動 allowlist ではなく構造で担保されている', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'src/mcp/server.js'), 'utf8');
  assert.ok(!/STORE_TOOLS/.test(src), '手動 allowlist（STORE_TOOLS）が残っている');
  assert.match(src, /async function callTool\(name, args = \{\}, getStore\)/,
    'callTool はリクエストスコープの getStore を引数で受け取るべき');
  assert.ok(!/^  const getStore = /m.test(src),
    '参照カウントの外側から呼べるモジュールスコープの getStore が残っている');
});

/**
 * 古いストアが store に居座るケース。
 *
 * openStore() は await の後で無条件に store = s と代入するため、その間に
 * invalidateStore() が store = null にしても、解決した古いストアが再代入されて居座る。
 * 結果、sync が索引を作り直した後も、次のリクエストが一世代前の索引を引く。
 *
 * IndexStore は開いた時点のスナップショットなので（#5）、古いストアを引いても例外には
 * ならず、検索は正常な形のまま「古い結果」を返す。1 段目の assert はその #5 の回帰検出
 * として残してある（再び TypeError が出るならスナップショット化が壊れている）。
 */
test('MCP: 索引オープン中に sync が入っても、次の検索は新しい索引を見る', async () => {
  const { dir, configPath } = await fixture({ build: true });
  // 索引作成後に追加する = sync するまで索引に存在しないファイル
  await fsp.writeFile(path.join(dir, 'src', 'refund_v2.js'),
    'function refundV2() { return "ZZTOPSECRETMARKER"; }\nmodule.exports = { refundV2 };\n');
  // 1 件目の open() を遅らせ、sync が先に完了する状況を確定的に作る
  const probe = await writeProbe(dir, configPath, { openDelayMs: 1500 });

  const { responses, opens } = await rpc(probe, [
    call(1, 'context_grill_search', { query: 'refund' }),
    call(2, 'context_grill_sync', {}),
  ], 2, { then: [call(3, 'context_grill_search', { query: 'ZZTOPSECRETMARKER refundV2' })] });

  const text = responses.find((r) => r.id === 3)?.result?.content?.[0]?.text ?? JSON.stringify(responses);
  const detail = `opens=${opens} 応答=${text.slice(0, 400)}`;
  // #5 の回帰検出。ここが落ちるなら IndexStore のスナップショット化が壊れている
  assert.doesNotMatch(text, /^エラー:/,
    `検索が例外で落ちている（IndexStore が開いた時点に固定されていない）。${detail}`);
  // 例外にならなくても、古い索引なら sync で追加された資料は引けない
  assert.match(text, /refund_v2\.js/,
    `sync 後の検索が古い索引を引いている（新しい資料が見えていない）。${detail}`);
});

/** publish 中の rename について、宛先が既に存在したかと宛先名を stderr に出す印。 */
const RENAME_MARK = '__CONTEXT_GRILL_RENAME__';

/**
 * publish で行われる rename をすべて報告する probe を書く。宛先が既に存在していたか
 * どうかを、rename を呼ぶ直前に見て印に乗せる。
 *
 * Windows では開いているファイルを rename の宛先にできず EPERM になる。世代番号方式は
 * 宛先を毎回未使用の名前にすることでこれを避けているので、「宛先が存在しない」が
 * 守るべき不変条件になる。これなら macOS / Linux でも決定的に見られる。
 *
 * 印は改行で挟む。writeProbe と同じ理由で、stdin の番兵行や SIGTERM ハンドラには
 * 頼れない（Windows に SIGTERM が無く、stdin は最初のリスナで流れ始めてしまう）。
 */
async function writeRenameProbe(dir, configPath) {
  const probe = path.join(dir, 'probe-rename.mjs');
  const NL = 'String.fromCharCode(10)';
  await fsp.writeFile(probe, `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
const origRename = fsp.rename.bind(fsp);
fsp.rename = async (a, b) => {
  process.stderr.write(${NL} + ${JSON.stringify(RENAME_MARK)} + (fs.existsSync(b) ? '1' : '0') + ':' + String(b) + ${NL});
  return origRename(a, b);
};
const { startMcpServer } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/mcp/server.js')).href)});
startMcpServer({ configPath: ${JSON.stringify(configPath)} });
`);
  return probe;
}

test('MCP: 検索でストアを開いた後でも sync が成功する（公開の宛先は常に未使用の名前）', async () => {
  const { dir, configPath } = await fixture({ build: true });
  const probe = await writeRenameProbe(dir, configPath);
  // 検索でストアを開かせてから sync する（実際の利用順序）
  const res = await rpc(probe, [call(1, 'context_grill_search', { query: 'refundPayment' })], 1, {
    then: [call(2, 'context_grill_sync', {})],
    thenExpected: 1,
  });
  const sync = res.responses.find((r) => r.id === 2);
  assert.ok(sync, 'sync の応答が無い: ' + res.stderr.slice(-300));
  assert.notEqual(sync.result?.isError, true, 'sync がエラーになった: ' + JSON.stringify(sync.result).slice(0, 300));

  const config = await loadConfig(configPath);
  const indexDir = paths(config).index;

  const all = (res.stderr.match(new RegExp(RENAME_MARK + '([01]):([^\\n]+)', 'g')) || [])
    .map((m) => { const s = m.slice(RENAME_MARK.length); return { existed: s[0] === '1', to: s.slice(2) }; });
  // 索引ディレクトリ内の rename だけを見る。IndexStore が fd を握るのはここだけで、
  // Windows の EPERM を踏む条件（宛先が開かれている）が成立するのもここだけ。
  // sync 側の docs.jsonl は既存名への rename だが、誰も fd を保持しない
  // （CLAUDE.md の未確認欄を参照）。
  const marks = all.filter((m) => m.to.startsWith(indexDir));
  assert.ok(marks.length > 0,
    `索引ディレクトリ内の rename が 1 回も観測できていない（probe が効いていないか、公開の仕組みが変わった）。全 ${all.length} 件: ` + all.map((m) => m.to).join(', ').slice(0, 300));
  for (const m of marks) {
    assert.ok(!m.existed,
      `rename の宛先 ${path.basename(m.to)} が既に存在していた（Windows で開かれていればここで EPERM になる）`);
  }
});

// --- --offline が MCP サーバーに効くこと ---
//
// startMcpServer は設定を自前で loadConfig し直すため、cmdMcp が --offline を渡さないと効かない。
// しかも runTaskWithStore / syncSources / buildIndex は呼ばれるたびに initEgress(config) をやり直す。
// POLICY だけを上書きする修正では、次の run_task で normal に戻る。
// そのため bin/ 経由（cmdMcp を通る経路）で起動し、設定値そのものが書き換わっていることを見る。
// （writeProbe は startMcpServer を直接 import するので cmdMcp を通らない）

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };

/** bin/context-grill.js を子プロセスで起動し、全リクエストを 1 回で送って応答を待つ。後始末は SIGKILL。 */
function rpcBin(dir, args, lines, expected, { env = {}, then = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'context-grill.js'), ...args], {
      cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    const responses = [];
    let out = '';
    let errText = '';
    let done = false;
    let sentThen = false;
    let target = expected;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('タイムアウト: ' + out + errText)); }, 20000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        try { responses.push(JSON.parse(line)); } catch { /* ignore */ }
      }
      // then を渡すと、最初の expected 件が返ってから続きを送る（同じプロセスでの「その後」を作る）
      if (then && !sentThen && responses.length >= expected) {
        sentThen = true;
        target = expected + then.length;
        child.stdin.write(then.map((l) => JSON.stringify(l)).join('\n') + '\n');
      }
      if (responses.length >= target && !done) { done = true; setTimeout(() => child.kill('SIGKILL'), 100); }
    });
    child.stderr.on('data', (c) => { errText += c; });
    child.on('close', () => { clearTimeout(timer); resolve({ responses, stderr: errText }); });
    child.on('error', reject);
    child.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
}

const egressModeOf = (res, id) => {
  const r = res.responses.find((x) => x.id === id);
  assert.ok(r, `id=${id} の応答が無い: ` + res.stderr.slice(-300));
  return JSON.parse(r.result.content[0].text).egress.mode;
};

for (const [label, args] of [['--offline mcp', ['--offline', 'mcp']], ['mcp --offline', ['mcp', '--offline']]]) {
  test(`MCP: ${label} で context_grill_status の egress.mode が offline になる`, async () => {
    const { dir, configPath } = await fixture({ build: true });
    const res = await rpcBin(dir, [...args, '-c', configPath], [INIT, call(2, 'context_grill_status', {})], 2);
    assert.equal(egressModeOf(res, 2), 'offline');
  });
}

test('MCP: --offline なしでは egress.mode は normal のまま（startMcpServer の既定は変わらない）', async () => {
  const { dir, configPath } = await fixture({ build: true });
  const res = await rpcBin(dir, ['mcp', '-c', configPath], [INIT, call(2, 'context_grill_status', {})], 2);
  assert.equal(egressModeOf(res, 2), 'normal');
});

test('MCP: --offline は run_task（dry_run）の後でも維持される（initEgress のやり直しで戻らない）', async () => {
  const { dir, configPath } = await fixture({ build: true });
  const res = await rpcBin(dir, ['--offline', 'mcp', '-c', configPath], [
    INIT,
    call(2, 'context_grill_run_task', { instruction: 'refundPayment の挙動', task: 'spec', dry_run: true }),
  ], 2, { then: [call(3, 'context_grill_status', {})] });
  const run = res.responses.find((r) => r.id === 2);
  assert.ok(run, 'run_task の応答が無い: ' + res.stderr.slice(-300));
  assert.notEqual(run.result?.isError, true, 'dry_run がエラーになった: ' + JSON.stringify(run.result).slice(0, 300));
  assert.equal(egressModeOf(res, 3), 'offline');
});

test('MCP: --offline では dry_run なしの run_task が送信前にブロックされ、egress.log も作られない', async () => {
  const { dir } = await fixture({ build: false });
  const keyEnv = 'CG_MCP_OFFLINE_TEST_KEY';
  const configPath = path.join(dir, 'offline.config.json');
  await fsp.writeFile(configPath, JSON.stringify({
    project: 'mcp-offline',
    sources: [{ id: 'repo', type: 'local', path: dir, include: ['src/**'] }],
    // .invalid は名前解決できない。offline が効いていなければ別のエラーになり、メッセージで区別できる
    llm: { provider: 'anthropic', model: 'test-model', apiKeyEnv: keyEnv, baseUrl: 'https://llm.invalid' },
    security: { allowLlmUpload: true },
  }));
  const config = await loadConfig(configPath);
  await syncSources(config, {});
  await buildIndex(config, { embed: false });
  const res = await rpcBin(dir, ['--offline', 'mcp', '-c', configPath], [
    INIT,
    call(2, 'context_grill_run_task', { instruction: 'refundPayment の挙動', task: 'spec' }),
  ], 2, { env: { [keyEnv]: 'dummy-not-a-real-key' } });
  const run = res.responses.find((r) => r.id === 2);
  assert.ok(run, 'run_task の応答が無い: ' + res.stderr.slice(-300));
  assert.equal(run.result?.isError, true, '送信がブロックされず成功した: ' + JSON.stringify(run.result).slice(0, 300));
  assert.match(run.result.content[0].text, /オフラインモード/);
  await assert.rejects(fsp.access(path.join(config.workspaceDir, 'egress.log')), { code: 'ENOENT' });
});

// --- ツール引数の検証（黙って通る失敗の防止） ---
//
// sources / effort / task / arguments の誤りは、索引を開く前に分かりやすいエラーで止める。
// 以前は、文字列の sources が String#includes の部分一致になる（"docsx" で docs が選ばれる）、
// 未知の effort が黙って normal になる、索引の無い環境で「索引がありません」が先に出る、
// arguments が false や "" だと黙って {} になる、といった形で素通りしていた。

const XDEEP = { queries: 1, final: 5, evidenceTokens: 5000 };

/** local ソース 2 つ（repo / docs）と独自の effort preset（xdeep）を持つ設定を置く。 */
async function fixture2({ build }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-mcp-args-'));
  await fsp.mkdir(path.join(dir, 'repo'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'repo', 'payment.js'),
    'function refundPayment(id) { return "repo-refund-marker"; }\nmodule.exports = { refundPayment };\n');
  await fsp.writeFile(path.join(dir, 'docs', 'guide.md'),
    '# guide\n\nrefundPayment の方針: docs-refund-marker\n');
  const configPath = path.join(dir, 'context-grill.config.json');
  await fsp.writeFile(configPath, JSON.stringify({
    project: 'mcp-args',
    sources: [
      { id: 'repo', type: 'local', path: path.join(dir, 'repo'), include: ['**/*'], includeUnknownTypes: true },
      { id: 'docs', type: 'local', path: path.join(dir, 'docs'), include: ['**/*'], includeUnknownTypes: true },
    ],
    llm: { provider: 'dry', model: 'dry' },
    effortPresets: {
      low: { queries: 3, final: 14, evidenceTokens: 20000 },
      normal: { queries: 6, final: 28, evidenceTokens: 55000 },
      deep: { queries: 12, final: 56, evidenceTokens: 110000 },
      xdeep: XDEEP,
    },
  }));
  if (build) {
    const config = await loadConfig(configPath);
    await syncSources(config, {});
    await buildIndex(config, { embed: false });
  }
  return { dir, configPath };
}

const textOf = (r) => r?.result?.content?.[0]?.text ?? JSON.stringify(r);
const byId = (res, id) => {
  const r = res.responses.find((x) => x.id === id);
  assert.ok(r, `id=${id} の応答が無い: ${res.stderr.slice(-300)}`);
  return r;
};

/**
 * 1 つのツールに対し、cases = [[args, 期待するメッセージ, schemaPath?], ...] がすべて拒否されることを見る。
 * 値の意味が不正なもの（未知の id など）は isError。schemaPath を付けたものは inputSchema に反する型違いで、
 * ツール実行前の JSON-RPC エラー -32602 になる（索引の有無より先に止まる点は同じ）。
 */
async function assertRejected(tool, cases, { build }) {
  const { dir, configPath } = await fixture2({ build });
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, cases.map(([args], i) => call(i + 1, tool, args)), cases.length);
  cases.forEach(([args, expected, schemaPath], i) => {
    const r = byId(res, i + 1);
    const label = `${tool} ${JSON.stringify(args)}`;
    if (schemaPath) {
      assert.ok(r.error?.code === -32602 && r.result === undefined, `${label} は -32602 のはず。応答全体: ${JSON.stringify(r).slice(0, 300)}`);
      assert.match(r.error.message, /inputSchema/, `${label}: ${r.error.message}`);
      assert.ok(r.error.message.includes(tool), `${label}: ツール名が無い: ${r.error.message}`);
      assert.ok(r.error.message.includes(schemaPath), `${label}: ${schemaPath} が無い: ${r.error.message}`);
      assert.match(r.error.message, expected, `${label}: ${r.error.message}`);
      return;
    }
    assert.equal(r.result?.isError, true, `${label} が拒否されていない。実際の応答: ${textOf(r).slice(0, 300)}`);
    assert.match(textOf(r), expected, `${label} のメッセージが違う。実際の応答: ${textOf(r).slice(0, 300)}`);
    assert.doesNotMatch(textOf(r), /索引がありません/, `${label}: 引数の検証より先に索引の有無が出ている`);
  });
}

const RUN_LIKE_CASES = [
  [{ instruction: 'x', task: 'constructor' }, /未知のタスク/],
  [{ instruction: 'x', effort: 'foo' }, /未知の effort/],
  [{ instruction: 'x', effort: 'constructor' }, /未知の effort/],
  [{ instruction: 'x', sources: ['nope'] }, /未知のソース/],
  [{ instruction: 'x', sources: 'repo' }, /型が array/, '$.sources'],
  [{ instruction: 'x', sources: [1] }, /型が string/, '$.sources[0]'],
  [{ instruction: 'x', sources: [''] }, /未知のソース/],
];
const SOURCES_ONLY_CASES = [
  [{ query: 'refund', sources: ['nope'] }, /未知のソース/],
  [{ query: 'refund', sources: 'docs' }, /型が array/, '$.sources'],
];

test('MCP: 索引が無くても run_task の引数（task / effort / sources）は索引エラーより先に検証される', async () => {
  await assertRejected('context_grill_run_task', RUN_LIKE_CASES, { build: false });
});

test('MCP: 索引が無くても evidence_pack の引数（task / effort / sources）は索引エラーより先に検証される', async () => {
  await assertRejected('context_grill_evidence_pack', RUN_LIKE_CASES, { build: false });
});

test('MCP: 索引が無くても search の sources は索引エラーより先に検証される', async () => {
  await assertRejected('context_grill_search', SOURCES_ONLY_CASES, { build: false });
});

test('MCP: 索引が無くても static_scan の sources は索引エラーより先に検証される', async () => {
  await assertRejected('context_grill_static_scan', SOURCES_ONLY_CASES.map(([a, m, p]) => [{ sources: a.sources }, m, p]), { build: false });
});

test('MCP: sync の sources は未知の id・文字列を拒否する（黙って何も同期しない / 部分一致で選ばない）', async () => {
  await assertRejected('context_grill_sync', SOURCES_ONLY_CASES.map(([a, m, p]) => [{ sources: a.sources }, m, p]), { build: false });
});

test('MCP: fetch の source は未知の id・文字列でない値・空文字を拒否する', async () => {
  await assertRejected('context_grill_fetch', [
    [{ path: 'payment.js', source: 'nope' }, /未知のソース/],
    [{ path: 'payment.js', source: 1 }, /型が string/, '$.source'],
    [{ path: 'payment.js', source: '' }, /未知のソース/],
  ], { build: false });
});

test('MCP: search の sources は文字列（部分一致）を拒否し、配列の id だけで絞り込む。[] と省略は全ソース', async () => {
  const { dir, configPath } = await fixture2({ build: true });
  const probe = await writeProbe(dir, configPath);
  const q = 'refundPayment';
  const res = await rpc(probe, [
    call(1, 'context_grill_search', { query: q, sources: 'docsx' }),
    call(2, 'context_grill_search', { query: q, sources: 'docs' }),
    call(3, 'context_grill_search', { query: q, sources: ['repo'] }),
    call(4, 'context_grill_search', { query: q, sources: ['repo', 'docs'] }),
    call(5, 'context_grill_search', { query: q, sources: [] }),
    call(6, 'context_grill_search', { query: q }),
    call(7, 'context_grill_static_scan', { sources: ['nope'] }),
  ], 7);
  for (const id of [1, 2]) {
    const r = byId(res, id);
    assert.ok(r.error?.code === -32602 && r.result === undefined, `id=${id}: 文字列の sources が -32602 で拒否されていない。応答全体: ${JSON.stringify(r).slice(0, 300)}`);
    assert.match(r.error.message, /inputSchema/, `id=${id}: ${r.error.message}`);
    assert.ok(r.error.message.includes('context_grill_search') && r.error.message.includes('$.sources'), `id=${id}: ${r.error.message}`);
    assert.match(r.error.message, /型が array/, `id=${id}: ${r.error.message}`);
  }
  const sourcesOf = (id) => {
    const r = byId(res, id);
    assert.notEqual(r.result?.isError, true, `id=${id} がエラー: ${textOf(r).slice(0, 200)}`);
    return new Set(JSON.parse(textOf(r)).map((x) => x.source));
  };
  assert.deepEqual([...sourcesOf(3)].sort(), ['repo'], 'sources:["repo"] は repo のみ');
  assert.deepEqual([...sourcesOf(4)].sort(), ['docs', 'repo']);
  assert.deepEqual([...sourcesOf(5)].sort(), ['docs', 'repo'], 'sources:[] は全ソース');
  assert.deepEqual([...sourcesOf(6)].sort(), ['docs', 'repo'], 'sources 省略は全ソース');
  const scan = byId(res, 7);
  assert.equal(scan.result?.isError, true, `static_scan の未知のソースが拒否されていない: ${textOf(scan).slice(0, 200)}`);
  assert.match(textOf(scan), /未知のソース/);
});

test('MCP: evidence_pack の effort は own の preset だけを受理する（xdeep は通り、省略は normal、foo は拒否）', async () => {
  const { dir, configPath } = await fixture2({ build: true });
  const probe = await writeProbe(dir, configPath);
  const ins = 'refundPayment の返金処理の仕様と制約を整理して';
  const res = await rpc(probe, [
    call(1, 'context_grill_evidence_pack', { instruction: ins, effort: 'xdeep' }),
    call(2, 'context_grill_evidence_pack', { instruction: ins }),
    call(3, 'context_grill_evidence_pack', { instruction: ins, effort: 'foo' }),
    call(4, 'context_grill_evidence_pack', { instruction: ins, effort: null }),
    call(5, 'context_grill_run_task', { instruction: ins, effort: 'xdeep', dry_run: true }),
    call(6, 'context_grill_run_task', { instruction: ins, effort: '', dry_run: true }),
  ], 6);
  const x = byId(res, 1);
  assert.notEqual(x.result?.isError, true, `xdeep が拒否された: ${textOf(x).slice(0, 200)}`);
  const xq = JSON.parse(textOf(x)).queries;
  assert.ok(xq.length >= 1 && xq.length <= XDEEP.queries, `xdeep のクエリ数は ${XDEEP.queries} 以内のはず（実際: ${xq.length}）`);
  const n = byId(res, 2);
  assert.notEqual(n.result?.isError, true, `effort 省略が拒否された: ${textOf(n).slice(0, 200)}`);
  const nq = JSON.parse(textOf(n)).queries;
  assert.ok(nq.length > XDEEP.queries && nq.length <= 6, `省略時は normal（最大 6）のはず（実際: ${nq.length}）`);
  const bad = byId(res, 3);
  assert.equal(bad.result?.isError, true, `effort:"foo" が黙って normal になった: ${textOf(bad).slice(0, 200)}`);
  assert.match(textOf(bad), /未知の effort/);
  const nul = byId(res, 4);
  assert.notEqual(nul.result?.isError, true, `effort:null は既定の normal のはず: ${textOf(nul).slice(0, 200)}`);
  const rt = byId(res, 5);
  assert.notEqual(rt.result?.isError, true, `run_task の xdeep が拒否された: ${textOf(rt).slice(0, 200)}`);
  const empty = byId(res, 6);
  assert.equal(empty.result?.isError, true, `run_task の effort:"" が黙って normal になった: ${textOf(empty).slice(0, 200)}`);
  assert.match(textOf(empty), /未知の effort/);
});

test('MCP: tools/call の arguments がオブジェクトでなければ -32602（null と省略だけが {} 扱い）', async () => {
  const { dir, configPath } = await fixture2({ build: true });
  const probe = await writeProbe(dir, configPath);
  const bads = [false, '', 0, [], '返金', true, 1];
  const reqs = bads.map((v, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'context_grill_status', arguments: v } }));
  const nullId = bads.length + 1;
  const omitId = bads.length + 2;
  reqs.push({ jsonrpc: '2.0', id: nullId, method: 'tools/call', params: { name: 'context_grill_status', arguments: null } });
  reqs.push({ jsonrpc: '2.0', id: omitId, method: 'tools/call', params: { name: 'context_grill_status' } });
  const res = await rpc(probe, reqs, reqs.length);
  bads.forEach((v, i) => {
    const r = byId(res, i + 1);
    assert.ok(r.error?.code === -32602 && r.result === undefined,
      `arguments=${JSON.stringify(v)} は -32602 のはず。応答全体: ${JSON.stringify(r).slice(0, 300)}`);
    assert.match(r.error.message, /params\.arguments はオブジェクト/);
  });
  for (const id of [nullId, omitId]) {
    const r = byId(res, id);
    assert.notEqual(r.result?.isError, true, `id=${id}: ${JSON.stringify(r).slice(0, 300)}`);
    assert.equal(JSON.parse(textOf(r)).indexed, true, `id=${id} で status が動かない: ${JSON.stringify(r).slice(0, 300)}`);
  }
});

test('MCP: serverInfo.version は package.json の version と一致する', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const res = await rpc(probe, [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }], 1);
  const r = byId(res, 1);
  assert.equal(r.result?.serverInfo?.name, 'context-grill');
  assert.equal(r.result?.serverInfo?.version, pkg.version, `serverInfo.version が package.json（${pkg.version}）と食い違う: ${JSON.stringify(r.result?.serverInfo)}`);
});

test('MCP: オブジェクトでない JSON の行は id:null の -32600 で返し、サーバーは落ちずに続行する', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const garbage = [null, [], [{ jsonrpc: '2.0', id: 9, method: 'ping' }], 1, 'x', true];
  const res = await rpc(probe, [...garbage, { jsonrpc: '2.0', id: 100, method: 'ping' }], garbage.length + 1);
  const nulls = res.responses.filter((x) => x.id === null);
  assert.equal(nulls.length, garbage.length, `id:null の応答が ${garbage.length} 件のはず（サーバーが落ちた可能性）。実際: ${nulls.length} 件。stderr: ${res.stderr.slice(-300)}`);
  for (const r of nulls) {
    assert.ok(r.error?.code === -32600 && r.result === undefined, `-32600 のはず: ${JSON.stringify(r)}`);
    assert.match(r.error.message, /^Invalid Request: /);
  }
  assert.deepEqual(byId(res, 100).result, {}, 'ping に応答できていない');
  assert.equal(res.responses.find((x) => x.id === 9), undefined, 'バッチの中身が実行されている');
});

test('MCP: method が文字列でない要求は id があれば -32600、通知の形なら何も返さない', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, [
    { jsonrpc: '2.0', id: 5 },
    { jsonrpc: '2.0', id: 6, method: 7 },
    { jsonrpc: '2.0' },
    { jsonrpc: '2.0', method: 7 },
    { jsonrpc: '2.0', id: 100, method: 'ping' },
  ], 3);
  for (const id of [5, 6]) {
    const r = byId(res, id);
    assert.ok(r.error?.code === -32600 && r.result === undefined, `id=${id} は -32600 のはず: ${JSON.stringify(r)}`);
    assert.match(r.error.message, /^Invalid Request: /);
  }
  assert.deepEqual(byId(res, 100).result, {});
  assert.equal(res.responses.length, 3, `id の無いメッセージに応答が返っている: ${JSON.stringify(res.responses)}`);
});

test('MCP: tools/call の未知のツール名（name が無い・数値・空文字を含む）は -32602 で、既知のツールは従来どおり動く', async () => {
  const { dir, configPath } = await fixture({ build: true });
  const probe = await writeProbe(dir, configPath);
  const bad = [
    { id: 1, params: { name: 'nope', arguments: {} } },
    { id: 2, params: { name: 5 } },
    { id: 3, params: { arguments: {} } },
    { id: 4, params: { name: '' } },
    { id: 5, params: { name: 'constructor' } },
    { id: 6 },
  ];
  const reqs = bad.map((b) => ({ jsonrpc: '2.0', method: 'tools/call', ...b }));
  reqs.push(call(7, 'context_grill_status', {}));
  const res = await rpc(probe, reqs, reqs.length);
  for (const b of bad) {
    const r = byId(res, b.id);
    assert.ok(r.error?.code === -32602 && r.result === undefined, `id=${b.id} は -32602 のはず: ${JSON.stringify(r).slice(0, 300)}`);
    assert.match(r.error.message, /^未知のツール: /);
  }
  assert.equal(byId(res, 1).error.message, '未知のツール: nope');
  const st = byId(res, 7);
  assert.notEqual(st.result?.isError, true, JSON.stringify(st).slice(0, 300));
  assert.equal(JSON.parse(textOf(st)).indexed, true);
});

// ---- tools/call の引数を inputSchema で検査する ----
// tools/list で公開している inputSchema は、以前は tools/call で検査されておらず、未知のキーが黙って無視される・
// enum 違いが通る・型違い（"false" は真、k:"12" など）が通る・必須項目の欠落が実行時の TypeError になる、
// といった形で素通りしていた。検査は preflight（意味の検証）より前に走り、反する引数は -32602 になる。
// 以降のテストは索引を作らない設定でも成立する（索引エラーより先に止まることも兼ねる）。

/** -32602 で、メッセージに inputSchema・ツール名・needles が全部含まれることを見る。 */
function assertSchemaError(r, tool, label, ...needles) {
  assert.ok(r.error?.code === -32602 && r.result === undefined, `${label} は -32602 のはず。応答全体: ${JSON.stringify(r).slice(0, 400)}`);
  assert.match(r.error.message, /inputSchema/, `${label}: ${r.error.message}`);
  assert.ok(r.error.message.includes(tool), `${label}: ツール名が無い: ${r.error.message}`);
  for (const n of needles) assert.ok(r.error.message.includes(n), `${label}: ${n} が無い: ${r.error.message}`);
}

const VALID_ARGS = {
  context_grill_status: {},
  context_grill_search: { query: 'x' },
  context_grill_evidence_pack: { instruction: 'x' },
  context_grill_verify: { pack_id: 'p', result: {} },
  context_grill_static_scan: {},
  context_grill_fetch: {},
  context_grill_run_task: { instruction: 'x' },
  context_grill_sync: {},
};

test('MCP: 全ツールで未知のキー（model / bogus）を -32602 で拒否する', async () => {
  const { dir, configPath } = await fixture2({ build: false });
  const probe = await writeProbe(dir, configPath);
  const tools = Object.keys(VALID_ARGS);
  const res = await rpc(probe, tools.map((t, i) => call(i + 1, t, { ...VALID_ARGS[t], model: 'x', bogus: 1, constructor: 1 })), tools.length);
  tools.forEach((t, i) => {
    // constructor は継承されたプロパティに当たるキー。スキーマの引き方次第で素通りしやすいので入れてある
    assertSchemaError(byId(res, i + 1), t, t, '$.model: 未定義のプロパティ', '$.bogus: 未定義のプロパティ', '$.constructor: 未定義のプロパティ');
  });
});

test('MCP: static_scan の severity は enum を検査する（hgih は拒否、high は通る）', async () => {
  const { dir, configPath } = await fixture2({ build: true });
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, [
    call(1, 'context_grill_static_scan', { severity: 'hgih' }),
    call(2, 'context_grill_static_scan', { severity: 'high' }),
  ], 2);
  assertSchemaError(byId(res, 1), 'context_grill_static_scan', 'severity:"hgih"', '$.severity', '"hgih"', '許可', 'critical, high, medium, low, info');
  const ok = byId(res, 2);
  assert.ok(ok.error === undefined && ok.result?.isError !== true, `severity:"high" は通るはず: ${JSON.stringify(ok).slice(0, 300)}`);
});

test('MCP: 引数の型違い（k / limit / dry_run / include_static / query / instruction）は -32602', async () => {
  await assertRejected('context_grill_search', [
    [{ query: 'x', k: '12' }, /型が integer/, '$.k'],
    [{ query: 5 }, /型が string/, '$.query'],
    [{ query: 'x', kinds: 'code' }, /型が array/, '$.kinds'],
  ], { build: false });
  await assertRejected('context_grill_static_scan', [[{ limit: 'x' }, /型が integer/, '$.limit']], { build: false });
  await assertRejected('context_grill_run_task', [
    [{ instruction: 'x', dry_run: 'false' }, /型が boolean/, '$.dry_run'],
    [{ instruction: 'x', dry_run: 0 }, /型が boolean/, '$.dry_run'],
    [{ instruction: 5 }, /型が string/, '$.instruction'],
  ], { build: false });
  await assertRejected('context_grill_evidence_pack', [
    [{ instruction: 'x', include_static: 'no' }, /型が boolean/, '$.include_static'],
    [{ instruction: 5 }, /型が string/, '$.instruction'],
  ], { build: false });
});

test('MCP: 必須項目の欠落と、必須項目の null は -32602', async () => {
  await assertRejected('context_grill_search', [
    [{}, /必須項目がありません/, '$.query'],
    [{ query: null }, /必須項目がありません/, '$.query'],
  ], { build: false });
  await assertRejected('context_grill_run_task', [[{}, /必須項目がありません/, '$.instruction']], { build: false });
  await assertRejected('context_grill_evidence_pack', [[{}, /必須項目がありません/, '$.instruction']], { build: false });
  await assertRejected('context_grill_verify', [
    [{}, /必須項目がありません/, '$.pack_id'],
    [{ pack_id: 'p' }, /必須項目がありません/, '$.result'],
    [{ result: {} }, /必須項目がありません/, '$.pack_id'],
  ], { build: false });
});

test('MCP: __proto__ を含む引数は黙って消えず、未定義のプロパティとして -32602', async () => {
  const { dir, configPath } = await fixture2({ build: false });
  const probe = await writeProbe(dir, configPath);
  const raw = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"context_grill_search","arguments":{"query":"x","__proto__":{"k":1}}}}';
  const rawNull = raw.replace('"__proto__":{"k":1}', '"__proto__":null');
  const reqs = [JSON.parse(raw), { ...JSON.parse(rawNull), id: 2 }];
  // 空振り防止: JSON.parse は __proto__ を own のキーとして作り、送る行にも残っていること
  for (const q of reqs) assert.ok(JSON.stringify(q).includes('"__proto__"'), `送る行に __proto__ が無い: ${JSON.stringify(q)}`);
  const res = await rpc(probe, reqs, 2);
  assertSchemaError(byId(res, 1), 'context_grill_search', '__proto__', '$.__proto__: 未定義のプロパティ');
  assertSchemaError(byId(res, 2), 'context_grill_search', '__proto__:null', '$.__proto__: 未定義のプロパティ');
});

test('MCP: スキーマにない null のキーは省略扱いにならず拒否される', async () => {
  await assertRejected('context_grill_search', [[{ query: 'x', model: null }, /未定義のプロパティ/, '$.model']], { build: false });
});

test('MCP: 正常な引数と、null の省略可キー・独自 effort（xdeep）・sources:[] は通り、tools/list の effort enum は設定の effortPresets を反映する', async () => {
  const { dir, configPath } = await fixture2({ build: true });
  const probe = await writeProbe(dir, configPath);
  const q = 'refundPayment';
  const ins = 'refundPayment の返金処理の仕様と制約を整理して';
  const res = await rpc(probe, [
    call(1, 'context_grill_search', { query: q }),
    call(2, 'context_grill_search', { query: q, k: 3, sources: ['repo'] }),
    call(3, 'context_grill_search', { query: q, k: null, sources: null, kinds: null }),
    call(4, 'context_grill_run_task', { instruction: ins, effort: null, task: null, sources: null, dry_run: null }),
    call(5, 'context_grill_evidence_pack', { instruction: ins, effort: 'xdeep' }),
    call(6, 'context_grill_run_task', { instruction: ins, effort: 'xdeep', dry_run: true }),
    call(7, 'context_grill_search', { query: q, sources: [] }),
    { jsonrpc: '2.0', id: 8, method: 'tools/list' },
    call(9, 'context_grill_static_scan', { sources: null, severity: null, limit: null }),
  ], 9);
  for (const id of [1, 2, 3, 4, 5, 6, 7, 9]) {
    const r = byId(res, id);
    assert.ok(r.error === undefined && r.result?.isError !== true, `id=${id} が通るはず: ${JSON.stringify(r).slice(0, 300)}`);
  }
  assert.equal(JSON.parse(textOf(byId(res, 2))).length <= 3, true, 'k:3 が効いていない');
  assert.deepEqual([...new Set(JSON.parse(textOf(byId(res, 2))).map((x) => x.source))], ['repo']);
  const both = (id) => [...new Set(JSON.parse(textOf(byId(res, id))).map((x) => x.source))].sort();
  assert.deepEqual(both(7), ['docs', 'repo'], 'sources:[] は全ソース');
  assert.deepEqual(both(3), ['docs', 'repo'], 'null の sources / k / kinds は省略扱い');
  const tool = byId(res, 8).result.tools.find((t) => t.name === 'context_grill_run_task');
  assert.deepEqual(tool.inputSchema.properties.effort.enum, ['low', 'normal', 'deep', 'xdeep'], 'tools/list の effort enum は effortPresets のキーを反映する');
});

// ---- pack_id のパス走査 ----
//
// verify / fetch は args.pack_id を検証せずに path.join(packDir, `${pack_id}.json`) へ渡していたため、
// "../../../secret" で packs ディレクトリの外にある <設定ディレクトリ>/secret.json が読めた。
// 形式の検査（preflight）で止まることを見るので、索引は要らない。

const PACK_SECRET = 'OUTSIDE-PACKS-DIR-CONTENT';
const PACK_ID_MESSAGE = /pack_id の形式が不正です/;

async function writePackSecret(dir) {
  await fsp.writeFile(path.join(dir, 'secret.json'),
    JSON.stringify({ pack: { items: [{ id: 'E1', text: PACK_SECRET }] }, taskId: 'spec' }));
}

const BAD_PACK_IDS = [
  '../../../secret', '', '../x', '..\\x', '/etc/passwd', 'C:\\x', 'pack-', 'pack-xyz',
  'pack-0123456789/../x', 'pack-0123456789.json', 'pack-012345678', 'pack-01234567890',
  'PACK-0123456789', 'pack-0123456789\n', 'constructor', '__proto__',
];

test('MCP: pack_id が packs の外を指すと fetch / verify は目印を漏らさず形式エラーにする', async () => {
  const { dir, configPath } = await fixture({ build: false });
  await writePackSecret(dir);
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, [
    call(1, 'context_grill_fetch', { pack_id: '../../../secret', evidence_id: 'E1' }),
    call(2, 'context_grill_verify', { pack_id: '../../../secret', result: {} }),
  ], 2);
  for (const id of [1, 2]) {
    const r = byId(res, id);
    const t = textOf(r);
    assert.doesNotMatch(t, new RegExp(PACK_SECRET), `id=${id}: packs の外の内容が応答に含まれている: ${t.slice(0, 300)}`);
    assert.equal(r.result?.isError, true, `id=${id} が拒否されていない。実際の応答: ${t.slice(0, 300)}`);
    assert.match(t, PACK_ID_MESSAGE, `id=${id}: メッセージが違う。実際の応答: ${t.slice(0, 300)}`);
    assert.ok(!t.includes('../../../secret'), `id=${id}: 不正な値そのものがメッセージに含まれている: ${t}`);
  }
});

test('MCP: 形式に合わない pack_id は fetch / verify の両方で形式エラーになる', async () => {
  const { dir, configPath } = await fixture({ build: false });
  await writePackSecret(dir);
  const probe = await writeProbe(dir, configPath);
  const reqs = [];
  for (const [i, bad] of BAD_PACK_IDS.entries()) {
    reqs.push(call(i * 2 + 1, 'context_grill_fetch', { pack_id: bad, evidence_id: 'E1' }));
    reqs.push(call(i * 2 + 2, 'context_grill_verify', { pack_id: bad, result: {} }));
  }
  const res = await rpc(probe, reqs, reqs.length);
  BAD_PACK_IDS.forEach((bad, i) => {
    for (const [k, tool] of [[1, 'context_grill_fetch'], [2, 'context_grill_verify']]) {
      const label = `${tool} pack_id=${JSON.stringify(bad)}`;
      const r = byId(res, i * 2 + k);
      const t = textOf(r);
      assert.equal(r.result?.isError, true, `${label} が拒否されていない。実際の応答: ${t.slice(0, 300)}`);
      assert.match(t, PACK_ID_MESSAGE, `${label}: メッセージが違う。実際の応答: ${t.slice(0, 300)}`);
      assert.doesNotMatch(t, new RegExp(PACK_SECRET), `${label}: 目印が漏れている`);
    }
  });
});

test('MCP: 形式が正しく存在しない pack_id は従来どおり「見つかりません」を返す', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, [
    call(1, 'context_grill_fetch', { pack_id: 'pack-0123456789', evidence_id: 'E1' }),
    call(2, 'context_grill_verify', { pack_id: 'pack-0123456789', result: {} }),
  ], 2);
  const f = textOf(byId(res, 1));
  const v = textOf(byId(res, 2));
  assert.match(f, /pack が見つかりません/, `fetch: ${f}`);
  assert.match(v, /pack_id pack-0123456789 が見つかりません/, `verify: ${v}`);
  assert.doesNotMatch(f + v, PACK_ID_MESSAGE, '形式は正しいのに形式エラーになっている');
});

test('MCP: evidence_pack が返した pack_id は fetch / verify で使え、pack_id 無しの fetch も動く', async () => {
  const { dir, configPath } = await fixture({ build: true });
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, [call(1, 'context_grill_evidence_pack', { instruction: 'refundPayment' })], 1);
  const packId = JSON.parse(textOf(byId(res, 1))).pack_id;
  assert.match(packId, /^pack-[0-9a-f]{10}$/, `pack_id の形が想定と違う: ${packId}`);
  const res2 = await rpc(probe, [
    call(1, 'context_grill_fetch', { pack_id: packId, evidence_id: 'E1' }),
    call(2, 'context_grill_verify', { pack_id: packId, result: {} }),
    call(3, 'context_grill_fetch', { source: 'repo', path: 'src/payment.js' }),
  ], 3);
  const f = byId(res2, 1);
  assert.notEqual(f.result?.isError, true, `fetch が拒否された: ${textOf(f).slice(0, 300)}`);
  assert.equal(JSON.parse(textOf(f)).id, 'E1', `fetch: ${textOf(f).slice(0, 300)}`);
  const v = byId(res2, 2);
  assert.notEqual(v.result?.isError, true, `verify が拒否された: ${textOf(v).slice(0, 300)}`);
  assert.equal(typeof JSON.parse(textOf(v)).passed, 'boolean', `verify: ${textOf(v).slice(0, 300)}`);
  const s = byId(res2, 3);
  assert.notEqual(s.result?.isError, true, `source+path の fetch が拒否された: ${textOf(s).slice(0, 300)}`);
  assert.match(textOf(s), /refundPayment/, `source+path の fetch: ${textOf(s).slice(0, 300)}`);
});

// --- initialize の protocolVersion 交渉 ---

/** initialize を 1 件送り、応答を返す。params に undefined を渡すと params キー自体を付けない。 */
async function initializeWith(params) {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const req = { jsonrpc: '2.0', id: 1, method: 'initialize' };
  if (params !== undefined) req.params = params;
  const res = await rpc(probe, [req], 1);
  return byId(res, 1);
}

test('MCP: initialize は対応表にある protocolVersion をそのまま返す', async () => {
  for (const v of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
    const r = await initializeWith({ protocolVersion: v });
    assert.equal(r.result?.protocolVersion, v, `${v}: ${JSON.stringify(r).slice(0, 300)}`);
  }
});

test('MCP: initialize は対応外の protocolVersion 文字列には最新版 2025-11-25 を返す', async () => {
  for (const v of ['garbage-9999', '1999-01-01', '2026-07-28', '2024-10-07', '2025-11-25-x', '']) {
    const r = await initializeWith({ protocolVersion: v });
    assert.equal(typeof r.result?.protocolVersion, 'string', `${JSON.stringify(v)}: ${JSON.stringify(r).slice(0, 300)}`);
    assert.equal(r.result.protocolVersion, '2025-11-25', `${JSON.stringify(v)} を送ったときの応答`);
  }
});

test('MCP: initialize は protocolVersion が省略・不正な型でも文字列の 2025-11-25 を返す（エラーにしない）', async () => {
  const cases = [
    ['キー省略', {}],
    ['params なし', undefined],
    ['数値', { protocolVersion: 123 }],
    ['オブジェクト', { protocolVersion: {} }],
    ['null', { protocolVersion: null }],
    ['空配列', { protocolVersion: [] }],
    ['対応版を含む配列', { protocolVersion: ['2025-11-25'] }],
    ['params が配列', []],
    ['params が文字列', 'x'],
  ];
  for (const [label, params] of cases) {
    const r = await initializeWith(params);
    assert.equal(r.error, undefined, `${label}: エラーになっている: ${JSON.stringify(r).slice(0, 300)}`);
    assert.equal(typeof r.result?.protocolVersion, 'string', `${label}: ${JSON.stringify(r).slice(0, 300)}`);
    assert.equal(r.result.protocolVersion, '2025-11-25', `${label} のときの応答`);
  }
});

test('MCP: Claude Code 2.1.231 の initialize（数値 id 0）に 2025-11-25 と従来の応答の形で返す', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, [{
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: { roots: { listChanged: true }, elicitation: {} },
      clientInfo: {
        name: 'claude-code',
        title: 'Claude Code',
        version: '2.1.231',
        description: "Anthropic's agentic coding tool",
        websiteUrl: 'https://claude.com/claude-code',
      },
    },
  }], 1);
  const r = byId(res, 0);
  assert.equal(r.id, 0);
  assert.equal(r.result?.protocolVersion, '2025-11-25');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false }, prompts: { listChanged: false } });
  assert.equal(r.result.serverInfo?.name, 'context-grill');
});

test('MCP: server/discover は id を保ったまま -32601 を返す（従来の initialize への切り替えを促す）', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, [{
    jsonrpc: '2.0',
    id: 'server-discover-probe-1',
    method: 'server/discover',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
  }], 1);
  const r = byId(res, 'server-discover-probe-1');
  assert.equal(r.error?.code, -32601, JSON.stringify(r).slice(0, 300));
  assert.equal(r.result, undefined);
});

// ---- 入力の大きさ・深さの上限と、パース失敗の応答 ----
//
// verify は検証後の result をそのまま返し、textResult が字下げするため、深さ d の配列で応答が約 2d² バイトに膨らむ
// （深さ 6000 の 12KB の要求で 72MB）。stdin の行にも上限が無く、不正な JSON の行は黙って捨てられていた。

/**
 * 生の文字列を、与えた単位のまま順に stdin へ書き、応答が expected 件そろうまで待つ（JSON.stringify しない）。
 * 失敗系は「応答が来ない」ことが症状なので、タイムアウトは reject せず、そろった分を返す。後始末は SIGKILL。
 */
function rpcRaw(probe, chunks, expected, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [probe], { stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = [];
    let out = '';
    let errText = '';
    let done = false;
    const finish = () => { if (!done) { done = true; setTimeout(() => child.kill('SIGKILL'), 100); } };
    const timer = setTimeout(finish, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        try { responses.push(JSON.parse(line)); } catch { /* ignore */ }
      }
      if (responses.length >= expected) finish();
    });
    child.stderr.on('data', (c) => { errText += c; });
    child.on('close', () => { clearTimeout(timer); resolve({ responses, stderr: errText, elapsedMs: Date.now() - started }); });
    child.on('error', reject);
    child.stdin.on('error', () => { /* kill 後の EPIPE */ });
    (async () => {
      for (const c of chunks) await new Promise((r) => child.stdin.write(c, r));
    })();
  });
}

const PING = (id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n';
const nest = (n) => '['.repeat(n) + ']'.repeat(n);
/** result 自体を深さ 1 と数えて、全体の深さが total になる result の JSON 文字列（余分なキー x に入れ子を置く）。 */
const resultOfDepth = (total) => `{"x":${nest(total - 1)}}`;
const verifyLine = (id, packId, resultJson) =>
  `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"context_grill_verify","arguments":{"pack_id":${JSON.stringify(packId)},"result":${resultJson}}}}\n`;
const TOO_BIG = /result が大きすぎるか深すぎます（深さ 64・2MB まで）/;
const findId = (res, id) => res.responses.find((x) => x.id === id);

test('MCP: verify は深さ 65 以上・2MB 超の result を pack を開く前に isError で拒否し、深さ 64 は通す', async () => {
  const { dir, configPath } = await fixture({ build: true });
  const probe = await writeProbe(dir, configPath);
  const packRes = await rpc(probe, [call(1, 'context_grill_evidence_pack', { instruction: 'refundPayment' })], 1);
  const packId = JSON.parse(textOf(byId(packRes, 1))).pack_id;
  const res = await rpcRaw(probe, [
    verifyLine(1, packId, resultOfDepth(64)),
    verifyLine(2, packId, resultOfDepth(65)),
    verifyLine(3, packId, resultOfDepth(100000)),
    verifyLine(4, packId, JSON.stringify({ x: 'x'.repeat(2_100_000) })),
    // pack が無くても、先に大きさ・深さで拒否される（pack を開く前に検査する）
    verifyLine(5, 'pack-0123456789', resultOfDepth(65)),
  ], 5);
  const ok64 = findId(res, 1);
  assert.ok(ok64, `深さ 64 の応答が無い: ${res.stderr.slice(-300)}`);
  assert.notEqual(ok64.result?.isError, true, `深さ 64 が拒否された: ${textOf(ok64).slice(0, 300)}`);
  assert.equal(typeof JSON.parse(textOf(ok64)).passed, 'boolean', textOf(ok64).slice(0, 300));
  for (const [id, label] of [[2, '深さ 65'], [3, '深さ 100000'], [4, '2MB 超'], [5, 'pack 無し + 深さ 65']]) {
    const r = findId(res, id);
    assert.ok(r, `${label} の応答が無い: ${res.stderr.slice(-300)}`);
    assert.equal(r.result?.isError, true, `${label} が拒否されていない: ${textOf(r).slice(0, 200)}`);
    assert.match(textOf(r), TOO_BIG, `${label}: メッセージが違う: ${textOf(r).slice(0, 200)}`);
    assert.ok(textOf(r).length < 1000, `${label}: 応答が大きい (${textOf(r).length})`);
  }
});

test('MCP: JSON として不正な行は -32700（id: null）で応答し、サーバーは生きている。空行は無視する', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const res = await rpcRaw(probe, ['{bad\n', '\n   \n', PING(7)], 2);
  assert.equal(res.responses.length, 2, `応答は不正な行の 1 件と ping の 1 件のみのはず: ${JSON.stringify(res.responses).slice(0, 400)}`);
  const pe = res.responses.find((x) => x.error);
  assert.ok(pe, `パース失敗の応答が無い: ${JSON.stringify(res.responses).slice(0, 400)}`);
  assert.equal(pe.error.code, -32700);
  assert.equal(pe.id, null);
  assert.equal(pe.error.message, 'Parse error: JSON として解釈できません');
  assert.deepEqual(findId(res, 7)?.result, {}, 'その後の ping が返らない');
});

test('MCP: 16MB を超える行は -32700（長すぎます）を 1 回だけ返して捨て、続く正常な行を処理する', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const big = 'a'.repeat(17 * 1024 * 1024);
  const MB = 1024 * 1024;
  const cases = [
    ['1 回の write（続きの行も同じ write）', [big + '\n' + PING(9)]],
    ['1MB ずつ複数チャンク', [...Array.from({ length: 17 }, () => 'a'.repeat(MB)), 'a'.repeat(1000) + '\n', PING(9)]],
  ];
  for (const [label, chunks] of cases) {
    const res = await rpcRaw(probe, chunks, 2);
    assert.equal(res.responses.length, 2, `${label}: 応答の件数が違う（-32700 が 1 回だけのはず）: ${JSON.stringify(res.responses).slice(0, 400)}`);
    const errs = res.responses.filter((x) => x.error);
    assert.equal(errs.length, 1, `${label}: -32700 は 1 回だけ: ${JSON.stringify(res.responses).slice(0, 400)}`);
    assert.equal(errs[0].error.code, -32700, label);
    assert.equal(errs[0].id, null, label);
    assert.match(errs[0].error.message, /Parse error: 行が長すぎます（上限 16MB）/, label);
    assert.deepEqual(findId(res, 9)?.result, {}, `${label}: 捨てた後の ping が返らない`);
    console.log(`# ${label}: ${res.elapsedMs}ms`);
  }
});

test('MCP: 上限に達しても改行を待つ間は読み捨て、改行以降の複数行は通常どおり処理する', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const MB = 1024 * 1024;
  // 改行なしで上限を超え → さらに続く（捨て状態で 2 チャンク）→ 改行 → 正常な 2 行
  const res = await rpcRaw(probe, ['a'.repeat(17 * MB), 'b'.repeat(MB), 'c'.repeat(10) + '\n' + PING(1) + PING(2)], 3);
  assert.equal(res.responses.length, 3, JSON.stringify(res.responses).slice(0, 400));
  assert.equal(res.responses.filter((x) => x.error).length, 1);
  assert.equal(res.responses.find((x) => x.error).error.code, -32700);
  assert.deepEqual(findId(res, 1)?.result, {});
  assert.deepEqual(findId(res, 2)?.result, {});
});

test('MCP: 1 回の write に複数行が入っていても、上限未満の大きな行（1MB）があっても従来どおり処理する', async () => {
  const { dir, configPath } = await fixture({ build: true });
  const probe = await writeProbe(dir, configPath);
  const res = await rpcRaw(probe, [
    PING(1) + PING(2),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping', params: { pad: 'x'.repeat(1024 * 1024) } }) + '\n',
    JSON.stringify(call(4, 'context_grill_search', { query: 'refundPayment '.repeat(75000) })) + '\n',
  ], 4);
  for (const id of [1, 2, 3]) assert.deepEqual(findId(res, id)?.result, {}, `id=${id}`);
  const s = findId(res, 4);
  assert.ok(s, '1MB の query の応答が無い');
  assert.notEqual(s.result?.isError, true, textOf(s).slice(0, 300));
});

// ---- pack ファイルの読み込み ----

async function packsDirOf(configPath) {
  const dir = path.join(paths(await loadConfig(configPath)).runs, 'packs');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

test('MCP: packs 内のシンボリックリンクが packs の外を指すと fetch / verify は「見つかりません」の isError にする', async (t) => {
  const { dir, configPath } = await fixture({ build: false });
  const packs = await packsDirOf(configPath);
  const outside = path.join(dir, 'outside.json');
  await fsp.writeFile(outside, JSON.stringify({ taskId: 'spec', pack: { items: [{ id: 'E1', text: 'OUTSIDE-MARKER' }] } }));
  try {
    await fsp.symlink(outside, path.join(packs, 'pack-0123456789.json'));
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip(`シンボリックリンクを作れない環境: ${e.code}`);
    throw e;
  }
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, [
    call(1, 'context_grill_fetch', { pack_id: 'pack-0123456789', evidence_id: 'E1' }),
    call(2, 'context_grill_verify', { pack_id: 'pack-0123456789', result: {} }),
  ], 2);
  for (const id of [1, 2]) {
    const r = byId(res, id);
    assert.equal(r.result?.isError, true, `id=${id} が拒否されていない: ${textOf(r).slice(0, 300)}`);
    assert.match(textOf(r), /pack_id pack-0123456789 が見つかりません/, `id=${id}: ${textOf(r).slice(0, 300)}`);
    assert.doesNotMatch(textOf(r), /OUTSIDE-MARKER/, `id=${id}: packs の外の内容が漏れている`);
  }
});

test('MCP: pack が JSON でない・形が違うときは本文を含まない「壊れています」の isError にする', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const packs = await packsDirOf(configPath);
  await fsp.writeFile(path.join(packs, 'pack-abcdefabcd.json'), 'hunter2-secret-body');
  await fsp.writeFile(path.join(packs, 'pack-abcdefabce.json'), '{}');
  await fsp.writeFile(path.join(packs, 'pack-abcdefabcf.json'), JSON.stringify({ taskId: 'spec', pack: { items: 'x' } }));
  const probe = await writeProbe(dir, configPath);
  const reqs = [];
  const ids = ['pack-abcdefabcd', 'pack-abcdefabce', 'pack-abcdefabcf'];
  ids.forEach((pid, i) => {
    reqs.push(call(i * 2 + 1, 'context_grill_fetch', { pack_id: pid, evidence_id: 'E1' }));
    reqs.push(call(i * 2 + 2, 'context_grill_verify', { pack_id: pid, result: {} }));
  });
  const res = await rpc(probe, reqs, reqs.length);
  ids.forEach((pid, i) => {
    for (const k of [1, 2]) {
      const r = byId(res, i * 2 + k);
      const text = textOf(r);
      assert.equal(r.result?.isError, true, `${pid} id=${i * 2 + k}: ${text.slice(0, 300)}`);
      assert.equal(text, `エラー: pack_id ${pid} が壊れています`, `${pid}: ${text.slice(0, 300)}`);
      assert.doesNotMatch(text, /hunter2/, `${pid}: 本文が漏れている`);
    }
  });
});

test('MCP: evidence_pack が作った正常な pack は fetch / verify で従来どおり読める（tmpdir がリンクでも）', async () => {
  const { dir, configPath } = await fixture({ build: true });
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, [call(1, 'context_grill_evidence_pack', { instruction: 'refundPayment' })], 1);
  const packId = JSON.parse(textOf(byId(res, 1))).pack_id;
  const res2 = await rpc(probe, [
    call(1, 'context_grill_fetch', { pack_id: packId, evidence_id: 'E1' }),
    call(2, 'context_grill_verify', { pack_id: packId, result: {} }),
  ], 2);
  assert.equal(JSON.parse(textOf(byId(res2, 1))).id, 'E1');
  assert.equal(typeof JSON.parse(textOf(byId(res2, 2))).passed, 'boolean');
});

// ---- 数値引数・kinds・instruction の inputSchema（minimum / maximum / enum / pattern）----
// k / limit / start / end は type:number のままだったため、0・負数・小数が黙って通り、件数や行範囲が不定になっていた。
// kinds の未知の値は 0 件で成功し、空文字や空白だけの instruction は汎用語だけのクエリで進んでいた。

/** 450 行の文書と、静的解析の検出が複数ある code を持つ local ソース 1 つの設定を置く。 */
async function fixtureRange() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'context-grill-mcp-range-'));
  await fsp.mkdir(path.join(dir, 'repo'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'repo', 'big.md'),
    Array.from({ length: 450 }, (_, i) => `line ${i + 1} refundPayment`).join('\n') + '\n');
  await fsp.writeFile(path.join(dir, 'repo', 'bad.js'),
    'const https = require("https");\n'
    + Array.from({ length: 5 }, (_, i) => `https.get(u${i}, { rejectUnauthorized: false });\neval(input${i});\n`).join(''));
  const configPath = path.join(dir, 'context-grill.config.json');
  await fsp.writeFile(configPath, JSON.stringify({
    project: 'mcp-range',
    sources: [{ id: 'repo', type: 'local', path: path.join(dir, 'repo'), include: ['**/*'], includeUnknownTypes: true }],
    llm: { provider: 'dry', model: 'dry' },
  }));
  const config = await loadConfig(configPath);
  await syncSources(config, {});
  await buildIndex(config, { embed: false });
  return { dir, configPath };
}

const parseText = (r) => JSON.parse(textOf(r));

test('MCP: search の k は 1〜100 の整数だけを受け付ける（0 / -1 / 0.5 / 101 / "12" は -32602）', async () => {
  const { dir, configPath } = await fixtureRange();
  const probe = await writeProbe(dir, configPath);
  const bad = [0, -1, 0.5, 1.5, 101, '12'];
  const reqs = bad.map((k, i) => call(i + 1, 'context_grill_search', { query: 'refundPayment', k }));
  reqs.push(call(20, 'context_grill_search', { query: 'refundPayment', k: 1 }));
  reqs.push(call(21, 'context_grill_search', { query: 'refundPayment', k: 100 }));
  const res = await rpc(probe, reqs, reqs.length);
  bad.forEach((k, i) => {
    const r = byId(res, i + 1);
    assertSchemaError(r, 'context_grill_search', `k:${JSON.stringify(k)}`, '$.k');
  });
  assert.match(byId(res, 1).error.message, /1 以上/);
  assert.match(byId(res, 5).error.message, /100 以下/);
  const one = byId(res, 20);
  assert.ok(one.error === undefined && one.result?.isError !== true, JSON.stringify(one).slice(0, 300));
  assert.equal(parseText(one).length, 1);
  const hundred = byId(res, 21);
  assert.ok(hundred.error === undefined && hundred.result?.isError !== true, JSON.stringify(hundred).slice(0, 300));
});

test('MCP: search の kinds は既知の kind だけ（"" / "Code" / "nope" は -32602、code / other / ticket は通る）', async () => {
  const { dir, configPath } = await fixtureRange();
  const probe = await writeProbe(dir, configPath);
  const bad = [[''], ['Code'], ['nope'], ['code', 'nope']];
  const reqs = bad.map((kinds, i) => call(i + 1, 'context_grill_search', { query: 'refundPayment', kinds }));
  reqs.push(call(20, 'context_grill_search', { query: 'refundPayment', kinds: ['code', 'other', 'ticket'] }));
  const res = await rpc(probe, reqs, reqs.length);
  bad.forEach((kinds, i) => {
    assertSchemaError(byId(res, i + 1), 'context_grill_search', `kinds:${JSON.stringify(kinds)}`, '許可');
  });
  const ok = byId(res, 20);
  assert.ok(ok.error === undefined && ok.result?.isError !== true, JSON.stringify(ok).slice(0, 300));
});

test('MCP: static_scan の limit は 1〜1000 の整数だけ（0 / -1 / 0.5 / 1001 は -32602）。limit:1 は 1 件に絞る', async () => {
  const { dir, configPath } = await fixtureRange();
  const probe = await writeProbe(dir, configPath);
  const bad = [0, -1, 0.5, 1001];
  const reqs = bad.map((limit, i) => call(i + 1, 'context_grill_static_scan', { limit }));
  reqs.push(call(20, 'context_grill_static_scan', {}));
  reqs.push(call(21, 'context_grill_static_scan', { limit: 1 }));
  const res = await rpc(probe, reqs, reqs.length);
  bad.forEach((limit, i) => assertSchemaError(byId(res, i + 1), 'context_grill_static_scan', `limit:${limit}`, '$.limit'));
  const all = parseText(byId(res, 20)).findings;
  assert.ok(all.length >= 2, `fixture に検出が 2 件以上必要: ${all.length}`);
  assert.equal(parseText(byId(res, 21)).findings.length, 1);
});

test('MCP: fetch の start / end は 1 以上の整数（start:0 / 1.5、end:-1 / 0 は -32602）', async () => {
  const { dir, configPath } = await fixtureRange();
  const probe = await writeProbe(dir, configPath);
  const base = { source: 'repo', path: 'big.md' };
  const bad = [{ start: 0 }, { start: 1.5 }, { end: -1 }, { end: 0 }];
  const res = await rpc(probe, bad.map((a, i) => call(i + 1, 'context_grill_fetch', { ...base, ...a })), bad.length);
  bad.forEach((a, i) => assertSchemaError(byId(res, i + 1), 'context_grill_fetch', JSON.stringify(a), a.start !== undefined ? '$.start' : '$.end'));
});

test('MCP: fetch は end < start を isError にし、end を付けても start から 201 行を超えない', async () => {
  const { dir, configPath } = await fixtureRange();
  const probe = await writeProbe(dir, configPath);
  const base = { source: 'repo', path: 'big.md' };
  const res = await rpc(probe, [
    call(1, 'context_grill_fetch', { ...base, start: 10, end: 5 }),
    call(2, 'context_grill_fetch', { ...base, start: 1, end: 400 }),
    call(3, 'context_grill_fetch', { ...base, start: 1, end: 5 }),
    call(4, 'context_grill_fetch', base),
    call(5, 'context_grill_fetch', { ...base, start: 100, end: 400 }),
    call(6, 'context_grill_fetch', { ...base, end: 3 }),
  ], 6);
  const r1 = byId(res, 1);
  assert.equal(r1.result?.isError, true, JSON.stringify(r1).slice(0, 300));
  assert.match(textOf(r1), /end は start 以上/);
  const r2 = parseText(byId(res, 2));
  assert.equal(r2.lines, '1-201');
  assert.equal(r2.text.split('\n').length, 201);
  assert.equal(parseText(byId(res, 3)).lines, '1-5');
  assert.equal(parseText(byId(res, 4)).lines, '1-201');
  assert.equal(parseText(byId(res, 5)).lines, '100-300');
  assert.equal(parseText(byId(res, 6)).lines, '1-3');
});

test('MCP: run_task / evidence_pack の instruction は空文字・空白だけを -32602 で拒否し、通常の指示は通る', async () => {
  const { dir, configPath } = await fixtureRange();
  const probe = await writeProbe(dir, configPath);
  const bad = ['', '   ', '\t\n'];
  const reqs = [];
  bad.forEach((instruction, i) => {
    reqs.push(call(i * 2 + 1, 'context_grill_run_task', { instruction, dry_run: true }));
    reqs.push(call(i * 2 + 2, 'context_grill_evidence_pack', { instruction }));
  });
  reqs.push(call(20, 'context_grill_run_task', { instruction: 'refundPayment を調べて', dry_run: true }));
  reqs.push(call(21, 'context_grill_evidence_pack', { instruction: 'refundPayment を調べて' }));
  const res = await rpc(probe, reqs, reqs.length);
  bad.forEach((instruction, i) => {
    assertSchemaError(byId(res, i * 2 + 1), 'context_grill_run_task', `run_task ${JSON.stringify(instruction)}`, '$.instruction');
    assertSchemaError(byId(res, i * 2 + 2), 'context_grill_evidence_pack', `evidence_pack ${JSON.stringify(instruction)}`, '$.instruction');
  });
  for (const id of [20, 21]) {
    const r = byId(res, id);
    assert.ok(r.error === undefined && r.result?.isError !== true, `id=${id}: ${JSON.stringify(r).slice(0, 300)}`);
  }
});

test('MCP: tools/list の inputSchema に新しい制約が出ている', async () => {
  const { dir, configPath } = await fixtureRange();
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], 1);
  const tools = byId(res, 1).result.tools;
  const props = (n) => tools.find((t) => t.name === n).inputSchema.properties;
  assert.deepEqual([props('context_grill_search').k.type, props('context_grill_search').k.minimum, props('context_grill_search').k.maximum], ['integer', 1, 100]);
  assert.deepEqual(props('context_grill_search').kinds.items.enum, ['code', 'doc', 'config', 'other', 'issue', 'pr', 'ticket']);
  assert.deepEqual([props('context_grill_static_scan').limit.type, props('context_grill_static_scan').limit.minimum, props('context_grill_static_scan').limit.maximum], ['integer', 1, 1000]);
  assert.deepEqual([props('context_grill_fetch').start.type, props('context_grill_fetch').start.minimum], ['integer', 1]);
  assert.deepEqual([props('context_grill_fetch').end.type, props('context_grill_fetch').end.minimum], ['integer', 1]);
  for (const n of ['context_grill_run_task', 'context_grill_evidence_pack']) {
    assert.equal(props(n).instruction.minLength, 1, n);
    assert.equal(props(n).instruction.pattern, '\\S', n);
  }
});

// --- resources の扱いと、offline + 埋め込みの sync ---

test('MCP: resources 系メソッドはすべて -32601（capability を宣言していないものに応答しない）', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const probe = await writeProbe(dir, configPath);
  const res = await rpc(probe, [
    { jsonrpc: '2.0', id: 1, method: 'resources/list' },
    { jsonrpc: '2.0', id: 2, method: 'resources/templates/list' },
    { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'x://y' } },
  ], 3);
  for (const id of [1, 2, 3]) {
    const r = res.responses.find((x) => x.id === id);
    assert.ok(r, `id=${id} の応答が無い`);
    assert.equal(r.error?.code, -32601, `id=${id}: ${JSON.stringify(r)}`);
  }
});

/** local ソース + 埋め込み（到達不能な 127.0.0.1:1）の設定を置く。 */
async function embedFixture({ allowEmbeddingUpload, baseUrl = 'http://127.0.0.1:1/v1' }) {
  const { dir } = await fixture({ build: false });
  const keyEnv = 'CG_MCP_EMBED_TEST_KEY';
  const configPath = path.join(dir, 'embed.config.json');
  await fsp.writeFile(configPath, JSON.stringify({
    project: 'mcp-embed',
    sources: [{ id: 'repo', type: 'local', path: dir, include: ['src/**'] }],
    llm: { provider: 'dry', model: 'dry' },
    retrieval: { embedding: { provider: 'openai-compat', model: 'm', dimensions: 8, baseUrl, apiKeyEnv: keyEnv } },
    security: { allowEmbeddingUpload },
  }));
  return { dir, configPath, env: { [keyEnv]: 'dummy-not-a-real-key' } };
}

test('MCP: --offline + 埋め込み設定の sync は report と公開済みの索引統計を返し、embedding.ok=false を添える', async () => {
  const { dir, configPath, env } = await embedFixture({ allowEmbeddingUpload: true });
  const res = await rpcBin(dir, ['--offline', 'mcp', '-c', configPath], [INIT, call(2, 'context_grill_sync', {})], 2,
    { env, then: [call(3, 'context_grill_search', { query: 'refundPayment' })] });
  const sync = res.responses.find((r) => r.id === 2);
  assert.ok(sync, 'sync の応答が無い: ' + res.stderr.slice(-300));
  assert.notEqual(sync.result?.isError, true, 'sync が isError になった: ' + JSON.stringify(sync.result).slice(0, 300));
  const body = JSON.parse(sync.result.content[0].text);
  assert.equal(body.sources[0].ok, true);
  assert.equal(body.embedding?.ok, false);
  assert.ok(typeof body.embedding?.error === 'string' && body.embedding.error.length > 0 && !body.embedding.error.includes('\n'));
  assert.ok(body.index && body.index.chunks >= 1, JSON.stringify(body.index));
  assert.ok(body.index.indexKey);
  const search = res.responses.find((r) => r.id === 3);
  assert.ok(search, 'search の応答が無い');
  assert.notEqual(search.result?.isError, true, JSON.stringify(search.result).slice(0, 300));
  assert.match(search.result.content[0].text, /refundPayment/);
});

test('MCP: allowEmbeddingUpload=false の sync は offline でも従来どおり isError（同意不足は握らない）', async () => {
  const { dir, configPath, env } = await embedFixture({ allowEmbeddingUpload: false });
  const res = await rpcBin(dir, ['--offline', 'mcp', '-c', configPath], [INIT, call(2, 'context_grill_sync', {})], 2, { env });
  const sync = res.responses.find((r) => r.id === 2);
  assert.ok(sync, 'sync の応答が無い: ' + res.stderr.slice(-300));
  assert.equal(sync.result?.isError, true, JSON.stringify(sync.result).slice(0, 300));
  assert.match(sync.result.content[0].text, /allowEmbeddingUpload/);
});

test('MCP: offline でない EgressBlocked（宛先ホストを解決できない）は握らず isError のまま', async () => {
  // スキーム無しの baseUrl は URL として解釈できず、normal モードでも EgressBlocked になる
  const { dir, configPath, env } = await embedFixture({ allowEmbeddingUpload: true, baseUrl: '127.0.0.1:1/v1' });
  const res = await rpcBin(dir, ['mcp', '-c', configPath], [INIT, call(2, 'context_grill_sync', {})], 2, { env });
  const sync = res.responses.find((r) => r.id === 2);
  assert.ok(sync, 'sync の応答が無い: ' + res.stderr.slice(-300));
  assert.equal(sync.result?.isError, true, JSON.stringify(sync.result).slice(0, 300));
  assert.match(sync.result.content[0].text, /宛先ホストを解決できません/);
});

test('MCP: 通常の sync の応答に embedding キーは無い', async () => {
  const { dir, configPath } = await fixture({ build: false });
  const res = await rpcBin(dir, ['mcp', '-c', configPath], [INIT, call(2, 'context_grill_sync', {})], 2);
  const sync = res.responses.find((r) => r.id === 2);
  assert.ok(sync, 'sync の応答が無い: ' + res.stderr.slice(-300));
  assert.notEqual(sync.result?.isError, true, JSON.stringify(sync.result).slice(0, 300));
  const body = JSON.parse(sync.result.content[0].text);
  assert.ok(!('embedding' in body), JSON.stringify(body));
  assert.ok(body.index.chunks >= 1);
});
