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
