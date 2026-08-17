import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, paths, ensureDirs, DEFAULTS, findConfigPath } from './config.js';
import { syncSources, buildIndex, allDocs } from './index/ingest.js';
import { IndexStore } from './index/store.js';
import { hybridSearch } from './index/search.js';
import { citationLabel } from './index/pack.js';
import { redactText } from './util/redact.js';
import { scanAll, summarize, projectFacts, extractEndpoints } from './analysis/static.js';
import { runTask } from './llm/pipeline.js';
import { TASKS, listTasks } from './tasks/index.js';
import { startMcpServer } from './mcp/server.js';
import { initEgress, egressPlan } from './util/egress.js';
import { SENSITIVE_DENY } from './util/sensitive.js';
import { urlToSource } from './util/urls.js';
import { log, setLevel } from './util/log.js';

const HELP = `context-grill — GitHub と Atlassian の一次資料に基づいて調査・設計を行うツール

使い方:
  context-grill <コマンド> [オプション]

コマンド:
  init                      context-grill.config.json のひな形を作成
  resolve <URL...>          ブラウザのURLを貼ると sources 定義を生成（--add で設定に追記）
  sync                      ソースを取得して索引を再構築
  build                     取得済みキャッシュから索引だけ再構築（ネットワーク不要）
  status                    索引とソースの状態を表示
  search <クエリ>           ハイブリッド検索（LLM を使わない・トークン消費ゼロ）
  scan                      静的解析（LLM を使わない・毎回同じ結果）
  ask <指示>                証拠付きで調査・回答を生成
  tasks                     利用可能なタスク種別を表示
  mcp                       MCP サーバーとして起動（stdio）
  doctor                    実行環境と設定の健全性チェック
  privacy                   どのデータがどこへ送られるかを表示（送信前の監査用）

共通オプション:
  -c, --config <path>       設定ファイルのパス
  --source <id>             対象ソースを限定（カンマ区切り）
  --json                    JSON で出力
  --log <level>             silent|error|warn|info|debug
  --offline                 一切の外部通信を禁止（検索・静的解析・--dry-run のみ動作）

sync:
  --full                    キャッシュを無視して全件再取得
  --no-embed                埋め込み生成をスキップ

search:
  -k, --top <n>             返す件数 (既定 20)
  --raw                     墨消しを無効化して原文を表示（取り扱い注意）

scan:
  --severity <lv>           critical|high|medium|low|info（既定 low 以上）
  --out <file>              結果を書き出す

ask:
  -t, --task <id>           spec|bug|security|static|design（既定 spec）
  -e, --effort <lv>         low|normal|deep（既定 normal）
  -m, --model <name>        モデルを一時的に上書き
  --dry-run                 LLM を呼ばずにプロンプト+証拠バンドルのみ生成（トークン 0）
  --out <file>              レポートの保存先

例:
  context-grill sync
  context-grill ask "決済リトライの仕様を整理して" --task spec
  context-grill ask "500 エラーが断続的に出る原因を調べて" --task bug --effort deep
  context-grill ask "認証まわりのセキュリティリスク" --task security --dry-run
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const alias = { c: 'config', k: 'top', t: 'task', e: 'effort', m: 'model', h: 'help', o: 'out' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split('=');
      let neg = false;
      if (k.startsWith('no-')) { neg = true; k = k.slice(3); }
      if (v === undefined) {
        if (neg) v = false;
        else if (argv[i + 1] && !argv[i + 1].startsWith('-')) v = argv[++i];
        else v = true;
      }
      out.flags[k] = v;
    } else if (a.startsWith('-') && a.length > 1) {
      const k = alias[a.slice(1)] || a.slice(1);
      let v = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
      out.flags[k] = v;
    } else out._.push(a);
  }
  return out;
}

const listOf = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

/** 設定読み込みの共通経路。--offline はここで強制適用する。 */
async function load(flags) {
  const config = await loadConfig(flags.config);
  if (flags.offline) config.security.networkMode = 'offline';
  initEgress(config);
  return config;
}

export async function main(argv) {
  const { _: pos, flags } = parseArgs(argv);
  if (flags.log) setLevel(String(flags.log));
  const cmd = pos[0];
  if (!cmd || flags.help || cmd === 'help') { process.stdout.write(HELP); return 0; }

  switch (cmd) {
    case 'init': return cmdInit(flags);
    case 'resolve': return cmdResolve(pos.slice(1), flags);
    case 'tasks': return cmdTasks(flags);
    case 'doctor': return cmdDoctor(flags);
    case 'privacy': return cmdPrivacy(flags);
    case 'sync': return cmdSync(flags);
    case 'build': return cmdBuild(flags);
    case 'status': return cmdStatus(flags);
    case 'search': return cmdSearch(pos.slice(1).join(' '), flags);
    case 'scan': return cmdScan(flags);
    case 'ask': return cmdAsk(pos.slice(1).join(' '), flags);
    case 'mcp': return cmdMcp(flags);
    default:
      process.stderr.write(`未知のコマンド: ${cmd}\n\n${HELP}`);
      return 1;
  }
}

// ---------------------------------------------------------------- init
async function cmdInit(flags) {
  const target = path.resolve(String(flags.dir || process.cwd()), 'context-grill.config.json');
  if (fs.existsSync(target) && !flags.force) {
    process.stderr.write(`${target} は既に存在します（--force で上書き）\n`);
    return 1;
  }
  const sample = {
    project: path.basename(path.dirname(target)),
    workspace: '.context-grill',
    sources: [
      {
        id: 'repo', type: 'github', repo: 'your-org/your-repo', ref: 'main', mode: 'clone',
        include: ['src/**', 'lib/**', 'app/**', 'docs/**', '*.md', 'package.json'],
        exclude: ['**/*.test.*', '**/__snapshots__/**'],
        auth: { tokenEnv: 'GITHUB_TOKEN' },
        issues: { enabled: false, limit: 100 }, pulls: { enabled: false, limit: 50 },
      },
      {
        id: 'wiki', type: 'confluence',
        baseUrl: 'https://your-org.atlassian.net/wiki', spaceKey: 'ENG', limit: 300,
        auth: { emailEnv: 'ATLASSIAN_EMAIL', tokenEnv: 'ATLASSIAN_API_TOKEN' },
      },
    ],
    retrieval: { embedding: { provider: 'none', model: 'text-embedding-3-small', dimensions: 512, apiKeyEnv: 'OPENAI_API_KEY' } },
    llm: { provider: 'anthropic', model: 'claude-sonnet-5', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    security: {
      networkMode: 'normal',
      allowHosts: [],
      denySensitivePaths: true,
      redactSecrets: true,
      allowEmbeddingUpload: false,
      allowLlmUpload: true,
      auditLog: true,
    },
  };
  await fsp.writeFile(target, JSON.stringify(sample, null, 2) + '\n');
  const envPath = path.join(path.dirname(target), '.env.example');
  if (!fs.existsSync(envPath)) {
    await fsp.writeFile(envPath, [
      '# 認証情報（.env は必ず .gitignore に入れてください）',
      'GITHUB_TOKEN=',
      'ATLASSIAN_EMAIL=',
      'ATLASSIAN_API_TOKEN=',
      'ANTHROPIC_API_KEY=',
      '# OPENAI_API_KEY=   # OpenAI / 埋め込みを使う場合',
      '# LLM_API_KEY=      # openai-compat（ローカル LLM など）を使う場合',
    ].join('\n') + '\n');
  }
  const dir = path.dirname(target);

  // 同梱ドキュメントを作業ディレクトリへコピーする（インストール先まで辿らずに読めるように）
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const copiedDocs = [];
  for (const name of ['commands.md', 'usage.md']) {
    const from = path.join(pkgRoot, name);
    const to = path.join(dir, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      try {
        await fsp.copyFile(from, to);
        copiedDocs.push(name);
      } catch { /* コピーできなくても初期化は続行する */ }
    }
  }

  const giPath = path.join(dir, '.gitignore');
  const gi = fs.existsSync(giPath) ? await fsp.readFile(giPath, 'utf8') : '';
  const missing = ['.env', '.context-grill/'].filter((e) => !gi.split(/\r?\n/).some((l) => l.trim() === e || l.trim() === e.replace(/\/$/, '')));
  process.stdout.write(`作成しました: ${target}\n`);
  if (missing.length) {
    process.stdout.write(
      `\n注意: ${giPath} に次の行が見つかりません。手動で追加してください（自動では変更しません）:\n` +
      missing.map((m) => `  ${m}\n`).join('') +
      `  ※ .context-grill/ 配下には .gitignore(*) が自動生成されるため、通常はコミット対象になりませんが、二重に防ぐことを推奨します。\n`);
  }
  if (copiedDocs.length) {
    process.stdout.write(`\nドキュメントを配置しました: ${copiedDocs.join(', ')}\n`);
  }

  process.stdout.write([
    '',
    '── 次の手順 ────────────────────────────────',
    '',
    '1) 調査対象を設定する',
    `     ${target}`,
    '   を開いて sources を書き換えます。使わないソースは削除してください。',
    '',
    '     GitHub    { "id": "repo", "type": "github", "repo": "owner/name", "ref": "main" }',
    '     ローカル   { "id": "proj", "type": "local",  "path": "../my-project" }',
    '',
    '   URL から自動生成することもできます:',
    '     context-grill resolve "https://github.com/owner/name" --add',
    '',
    '2) 認証情報を用意する（必要な場合のみ）',
    '     .env.example を .env にコピーして編集します。',
    '     GITHUB_TOKEN       private リポジトリを見る場合',
    '                        （git の資格情報ヘルパーが設定済みなら不要なことがあります）',
    '     ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN   Confluence / Jira を見る場合',
    '     ANTHROPIC_API_KEY  ask で回答を生成する場合',
    '     ※ search / scan / ask --dry-run だけなら、いずれも不要です',
    '',
    '3) 索引を作って使う',
    '     context-grill doctor                    環境と設定を確認',
    '     context-grill sync                      資料を取得して索引を構築',
    '     context-grill search "キーワード"         検索（LLM 不使用・キー不要）',
    '     context-grill ask "調べたいこと" --dry-run --out bundle.md',
    '                                             証拠パックを生成（LLM 不使用・キー不要）',
    '',
    '   コマンドの一覧と使用例は commands.md、',
    '   調査対象の指定方法は usage.md を参照してください。',
    '',
    '   送信内容を事前に確認する: context-grill privacy',
    '',
  ].join('\n') + '\n');
  return 0;
}

// ------------------------------------------------------------- resolve
async function cmdResolve(urls, flags) {
  if (!urls.length) {
    process.stderr.write('URL を指定してください。例:\n  context-grill resolve "https://github.com/acme/api" "https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/仕様"\n');
    return 1;
  }
  const results = urls.map((u, i) => ({ url: u, ...urlToSource(u, { id: typeof flags.id === 'string' && urls.length === 1 ? flags.id : undefined }) }));
  const sources = results.map((r) => r.source).filter(Boolean);

  // id の重複を避ける
  const used = new Set();
  for (const s of sources) {
    let id = s.id, n = 2;
    while (used.has(id)) id = `${s.id}-${n++}`;
    s.id = id; used.add(id);
  }

  if (flags.json) { process.stdout.write(JSON.stringify({ sources, notes: results.flatMap((r) => r.notes) }, null, 2) + '\n'); return sources.length ? 0 : 1; }

  for (const r of results) {
    process.stdout.write(`\n■ ${r.url}\n`);
    if (!r.source) { for (const n of r.notes) process.stdout.write(`  ! ${n}\n`); continue; }
    for (const n of r.notes) process.stdout.write(`  ※ ${n}\n`);
  }
  process.stdout.write('\n--- context-grill.config.json の "sources" に貼り付けてください ---\n');
  process.stdout.write(JSON.stringify(sources, null, 2) + '\n');

  if (flags.add) {
    const cfgPath = flags.config ? path.resolve(String(flags.config)) : findConfigPath();
    if (!cfgPath) { process.stderr.write('\n設定ファイルが見つかりません（context-grill init を先に実行してください）\n'); return 1; }
    const raw = JSON.parse(await fsp.readFile(cfgPath, 'utf8'));
    raw.sources = raw.sources || [];
    const existing = new Set(raw.sources.map((s) => s.id));
    let added = 0;
    for (const s of sources) {
      let id = s.id, n = 2;
      while (existing.has(id)) id = `${s.id}-${n++}`;
      raw.sources.push({ ...s, id });
      existing.add(id); added++;
    }
    await fsp.writeFile(cfgPath, JSON.stringify(raw, null, 2) + '\n');
    process.stdout.write(`\n${cfgPath} に ${added} 件追記しました。\n次: context-grill sync\n`);
  } else if (sources.length) {
    process.stdout.write('\n（--add を付けると設定ファイルに直接追記します）\n');
  }
  return sources.length ? 0 : 1;
}

async function cmdTasks(flags) {
  const t = listTasks();
  if (flags.json) { process.stdout.write(JSON.stringify(t, null, 2) + '\n'); return 0; }
  for (const x of t) process.stdout.write(`${x.id.padEnd(10)} ${x.label}\n            item types: ${x.itemTypes.join(', ')}\n`);
  return 0;
}

// -------------------------------------------------------------- doctor
async function cmdDoctor(flags) {
  const checks = [];
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
  checks.push({ name: 'Node.js >= 20', ok: nodeOk, detail: process.version });
  checks.push({ name: 'fetch API', ok: typeof fetch === 'function', detail: typeof fetch });
  let gitOk = false, gitVer = '';
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    gitVer = (await promisify(execFile)('git', ['--version'])).stdout.trim();
    gitOk = true;
  } catch { gitVer = '未インストール（github source の mode:"api" のみ利用可）'; }
  checks.push({ name: 'git CLI', ok: gitOk, detail: gitVer });

  const cfgPath = flags.config ? path.resolve(String(flags.config)) : findConfigPath();
  checks.push({ name: '設定ファイル', ok: Boolean(cfgPath), detail: cfgPath || '見つかりません（context-grill init）' });

  let config = null;
  if (cfgPath) {
    try { config = await loadConfig(cfgPath); checks.push({ name: '設定の妥当性', ok: true, detail: `${config.sources.length} ソース` }); }
    catch (e) { checks.push({ name: '設定の妥当性', ok: false, detail: e.message }); }
  }
  if (config) {
    const need = new Set([config.llm.apiKeyEnv]);
    for (const s of config.sources) {
      if (s.auth?.tokenEnv) need.add(s.auth.tokenEnv);
      if (s.auth?.emailEnv) need.add(s.auth.emailEnv);
    }
    if (config.retrieval.embedding.provider !== 'none') need.add(config.retrieval.embedding.apiKeyEnv);
    for (const n of need) {
      if (!n) continue;
      const optional = config.llm.provider === 'dry' && n === config.llm.apiKeyEnv;
      checks.push({ name: `env ${n}`, ok: Boolean(process.env[n]) || optional, detail: process.env[n] ? '設定済み' : (optional ? '不要' : '未設定') });
    }
    const p = paths(config);
    checks.push({ name: '索引', ok: IndexStore.exists(p.index), detail: IndexStore.exists(p.index) ? p.index : '未構築（context-grill sync）' });
    initEgress(config);
    const plan = egressPlan();
    checks.push({ name: '送信許可ホスト', ok: true, detail: plan.hosts.map((h) => h.host).join(', ') || 'なし（オフライン相当）' });
    checks.push({ name: '機密パス除外', ok: config.security.denySensitivePaths !== false, detail: config.security.denySensitivePaths !== false ? '有効' : '無効（非推奨）' });
    checks.push({ name: 'シークレット墨消し', ok: config.security.redactSecrets !== false, detail: config.security.redactSecrets !== false ? '有効' : '無効（非推奨）' });
  }

  if (flags.json) { process.stdout.write(JSON.stringify(checks, null, 2) + '\n'); return checks.every((c) => c.ok) ? 0 : 1; }
  for (const c of checks) process.stdout.write(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(26)} ${c.detail}\n`);
  return checks.every((c) => c.ok) ? 0 : 1;
}

// ---------------------------------------------------------------- sync
async function cmdSync(flags) {
  const config = await load(flags);
  await ensureDirs(config);
  const only = listOf(flags.source);
  const report = await syncSources(config, { only, force: Boolean(flags.full) });
  const manifest = await buildIndex(config, { embed: flags.embed !== false });
  const out = { sources: report, index: { chunks: manifest.N, terms: manifest.terms, dims: manifest.dims, indexKey: manifest.indexKey } };
  if (flags.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  else process.stdout.write(`同期完了: ${report.filter((r) => r.ok).length}/${report.length} ソース, ${manifest.N} チャンク\n`);
  return report.every((r) => r.ok) ? 0 : 1;
}

async function cmdBuild(flags) {
  const config = await load(flags);
  const manifest = await buildIndex(config, { embed: flags.embed !== false });
  process.stdout.write(`索引再構築: ${manifest.N} チャンク / ${manifest.terms} 語\n`);
  return 0;
}

// -------------------------------------------------------------- status
async function cmdStatus(flags) {
  const config = await load(flags);
  const p = paths(config);
  if (!IndexStore.exists(p.index)) {
    process.stdout.write('索引がまだありません。`context-grill sync` を実行してください。\n');
    return 1;
  }
  const store = await IndexStore.open(p.index);
  const stats = store.stats();
  await store.close();
  if (flags.json) { process.stdout.write(JSON.stringify(stats, null, 2) + '\n'); return 0; }
  process.stdout.write(`プロジェクト: ${config.project}\n索引: ${stats.chunks} チャンク / ${stats.terms} 語 / ベクトル次元 ${stats.dims || 'なし(BM25のみ)'}\n構築: ${stats.builtAt}\n索引キー: ${stats.indexKey}\n\n`);
  for (const [id, s] of Object.entries(stats.sources)) {
    process.stdout.write(`  ${id.padEnd(16)} ${String(s.documents).padStart(5)} 資料 / ${String(s.chunks).padStart(6)} チャンク  ${Object.entries(s.kinds).map(([k, v]) => `${k}:${v}`).join(' ')}\n`);
  }
  return 0;
}

// -------------------------------------------------------------- search
async function cmdSearch(query, flags) {
  if (!query) { process.stderr.write('検索クエリを指定してください\n'); return 1; }
  const config = await load(flags);
  const p = paths(config);
  const store = await IndexStore.open(p.index);
  const only = listOf(flags.source);
  const k = Number(flags.top || 20);
  const results = await hybridSearch(store, {
    queries: [query], config, k,
    filter: only ? (m) => only.includes(m.sourceId) : null,
    kindPriors: {}, sourcePriority: {},
  });
  await store.close();
  // 既定で墨消し（出力をチケットやチャットに貼っても認証情報が漏れないようにする）
  const doRedact = config.security?.redactSecrets !== false && !flags.raw;
  const view = (t) => (doRedact ? redactText(t).text : t);
  if (flags.raw) process.stderr.write('[context-grill:warn]  --raw: 墨消しを無効化しています。出力の取り扱いに注意してください。\n');
  if (flags.json) { process.stdout.write(JSON.stringify(results.map((r) => ({ ...r, text: view(r.text).slice(0, 1200) })), null, 2) + '\n'); return 0; }
  for (const r of results) {
    process.stdout.write(`\n#${r.rank} (${r.score.toFixed(4)}) ${citationLabel(r)}\n${r.url ? r.url + '\n' : ''}`);
    process.stdout.write(view(r.text).split('\n').slice(0, 8).map((l) => '  | ' + l).join('\n') + '\n');
  }
  return 0;
}

// ---------------------------------------------------------------- scan
async function cmdScan(flags) {
  const config = await load(flags);
  const only = listOf(flags.source);
  const docs = await allDocs(config, only);
  const findings = scanAll(docs, { minSeverity: String(flags.severity || 'low'), includeTestPaths: Boolean(flags.includeTests) });
  const out = { summary: summarize(findings), findings, facts: projectFacts(docs), endpoints: extractEndpoints(docs) };
  if (flags.out) {
    await fsp.writeFile(path.resolve(String(flags.out)), JSON.stringify(out, null, 2));
    process.stdout.write(`保存しました: ${flags.out}\n`);
  }
  if (flags.json) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); return 0; }
  process.stdout.write(`検出 ${out.summary.total} 件: ${Object.entries(out.summary.bySeverity).map(([k, v]) => `${k}=${v}`).join(' ')}\n\n`);
  for (const f of findings.slice(0, 60)) {
    process.stdout.write(`[${f.severity}] ${f.ruleId}  ${f.sourceId}/${f.path}:${f.line}\n    ${f.title}\n    ${f.snippet}\n`);
  }
  if (findings.length > 60) process.stdout.write(`\n… 他 ${findings.length - 60} 件（--json で全件）\n`);
  return 0;
}

// ----------------------------------------------------------------- ask
async function cmdAsk(instruction, flags) {
  if (!instruction) { process.stderr.write('指示を指定してください。例: context-grill ask "認証の仕様を整理して" --task spec\n'); return 1; }
  const config = await load(flags);
  const taskId = String(flags.task || 'spec');
  if (!TASKS[taskId]) { process.stderr.write(`未知のタスク: ${taskId}（${Object.keys(TASKS).join(', ')}）\n`); return 1; }
  const res = await runTask(config, {
    taskId, instruction,
    effort: String(flags.effort || 'normal'),
    sourceIds: listOf(flags.source),
    dryRun: Boolean(flags['dry-run'] || flags.dryRun),
    modelOverride: typeof flags.model === 'string' ? flags.model : null,
  });
  if (flags.out) {
    await fsp.writeFile(path.resolve(String(flags.out)), res.markdown);
    process.stderr.write(`レポートを保存しました: ${flags.out}\n`);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({ runId: res.runId, meta: res.meta, verification: res.verification, result: res.result, evidence: res.pack.items.map((e) => ({ id: e.id, label: e.label, url: e.url })) }, null, 2) + '\n');
  } else {
    process.stdout.write(res.markdown + '\n');
  }
  process.stderr.write(`\n実行結果一式: ${res.runDir}\n`);
  return 0;
}

// -------------------------------------------------------------- privacy
async function cmdPrivacy(flags) {
  const config = await load(flags);
  const plan = egressPlan();
  const sec = config.security;
  const embOn = config.retrieval.embedding.provider !== 'none';
  const llmOn = config.llm.provider !== 'dry' && sec.allowLlmUpload !== false;

  const data = {
    networkMode: plan.mode,
    allowedHosts: plan.hosts,
    auditLog: plan.auditLog,
    outbound: [
      { target: 'ソース取得 (GitHub / Confluence / Jira)', sends: '認証情報のみ（資料は受信方向）', enabled: true },
      { target: `埋め込み API (${config.retrieval.embedding.provider})`, sends: '索引対象の全チャンク本文（墨消し済み）', enabled: embOn,
        gate: sec.allowEmbeddingUpload ? 'security.allowEmbeddingUpload=true で許可済み' : 'security.allowEmbeddingUpload=false のためブロック' },
      { target: `LLM API (${config.llm.provider} / ${config.llm.model})`, sends: '検索でヒットした証拠のみ（墨消し済み・全文ではない）', enabled: llmOn,
        gate: sec.allowLlmUpload === false ? 'security.allowLlmUpload=false のためブロック' : '有効（--dry-run で送信せずに内容確認可）' },
    ],
    localWrites: [
      `${paths(config).workspace}/ 配下のみ（権限 ${(sec.workspaceMode ?? 0o700).toString(8)}）`,
      '--out で指定したファイル',
      'init 実行時の context-grill.config.json / .env.example',
    ],
    neverWrites: ['ユーザーのリポジトリ（git push / commit / add / checkout は実装上到達不能）', 'Confluence / Jira（参照系 API のみ）'],
    sensitiveDenyPatterns: sec.denySensitivePaths === false ? ['(無効化されています — 非推奨)'] : SENSITIVE_DENY,
    redaction: sec.redactSecrets === false ? '無効（非推奨）' : '有効（証拠・静的解析結果・埋め込み送信本文）',
  };

  if (flags.json) { process.stdout.write(JSON.stringify(data, null, 2) + '\n'); return 0; }
  const w = process.stdout.write.bind(process.stdout);
  w(`\nネットワークモード: ${data.networkMode}${data.networkMode === 'offline' ? '（すべての外部通信を拒否）' : ''}\n`);
  w(`監査ログ: ${data.auditLog || '無効'}\n`);
  w('\n■ 送信が許可されているホスト（これ以外へは送信不可）\n');
  if (!data.allowedHosts.length) w('  (なし)\n');
  for (const h of data.allowedHosts) w(`  ${h.host.padEnd(34)} ${h.reason}\n`);
  w('\n■ 外部へ出るデータ\n');
  for (const o of data.outbound) {
    w(`  ${o.enabled ? '送信あり' : '送信なし'}  ${o.target}\n        内容: ${o.sends}\n`);
    if (o.gate) w(`        制御: ${o.gate}\n`);
  }
  w('\n■ ローカル書き込み先\n');
  for (const l of data.localWrites) w(`  ・${l}\n`);
  w('\n■ 書き込まないもの\n');
  for (const l of data.neverWrites) w(`  ・${l}\n`);
  w(`\n■ シークレット墨消し: ${data.redaction}\n`);
  w(`■ 索引から無条件除外するパターン: ${data.sensitiveDenyPatterns.length} 件（--json で全件）\n`);
  w(`   例: ${data.sensitiveDenyPatterns.slice(0, 8).join(', ')} …\n\n`);
  return 0;
}

async function cmdMcp(flags) {
  await startMcpServer({ configPath: flags.config ? String(flags.config) : undefined });
  return 0;
}
