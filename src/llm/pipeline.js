import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config.js';
import { IndexStore } from '../index/store.js';
import { hybridSearch } from '../index/search.js';
import { buildEvidencePack, renderEvidenceBlock } from '../index/pack.js';
import { allDocs } from '../index/ingest.js';
import { scanAll, projectFacts, extractEndpoints, renderStaticFacts, summarize } from '../analysis/static.js';
import { TASKS, SYSTEM_CONTRACT, envelopeSchema, planQueries, taskPromptHash } from '../tasks/index.js';
import { createProvider } from './provider.js';
import { verify, renderViolations } from '../verify/gate.js';
import { renderMarkdown, renderBundle } from '../report/render.js';
import { estimateTokens } from '../util/tokens.js';
import { shortHash } from '../util/misc.js';
import { log } from '../util/log.js';
import { initEgress, egressSummary } from '../util/egress.js';

export function resolveTask(taskId) {
  const task = TASKS[taskId];
  if (!task) throw new Error(`未知のタスク: ${taskId}（利用可能: ${Object.keys(TASKS).join(', ')}）`);
  return task;
}

/**
 * 実行の骨格。ステージ 1〜4（証拠の決定）は LLM に一切依存しない。
 * LLM が担うのはステージ 5（証拠の解釈）だけで、その出力はステージ 6 で機械検証される。
 * → モデルや実行回数が変わっても、根拠と検証基準は不変。
 *
 * 索引を自前で開いて閉じる。既にストアを持っている呼び出し側（MCP サーバーなど）は
 * runTaskWithStore() を直接使うこと。
 */
export async function runTask(config, opts) {
  // 索引を開く前にタスク名を検証する。逆にすると、索引が無い環境で
  // タスク名を間違えた場合に「索引がありません」という無関係なエラーになる。
  resolveTask(opts.taskId);

  // --- 1. 索引を開く -------------------------------------------------
  // 本体を try/finally の内側に置き、例外パスでも fd を必ず解放する。
  // ここを成功パスだけの close() に戻すと、MCP サーバー（常駐プロセス）で
  // run_task が失敗するたびに fd が漏れ、いずれ EMFILE に至る。
  // 特に allowLlmUpload=false は設定で固定される方針なので、その配布先では
  // run_task が毎回確実に失敗し、毎回確実に漏れることになる。
  const store = await IndexStore.open(paths(config).index);
  try {
    return await runTaskWithStore(store, config, opts);
  } finally {
    await store.close();
  }
}

/**
 * 既存のストアを使って実行する。**ストアの所有権は呼び出し側にあり、
 * この関数は store.close() を呼ばない。**
 *
 * MCP サーバーは常駐プロセスでストアを 1 つキャッシュしているため、
 * こちらを使って二重オープンを避ける。
 */
export async function runTaskWithStore(store, config, opts) {
  const task = resolveTask(opts.taskId);
  const {
    taskId, instruction, effort = 'normal', sourceIds = null,
    dryRun = false, save = true, modelOverride = null, extraQueries = [],
  } = opts;
  const preset = config.effortPresets[effort] || config.effortPresets.normal;
  const startedAt = new Date().toISOString();
  const p = paths(config);
  initEgress(config);

  const filter = sourceIds ? (m) => sourceIds.includes(m.sourceId) : null;

  // --- 2. 決定的クエリ計画 -------------------------------------------
  const queries = [...planQueries(taskId, instruction, { max: preset.queries }), ...extraQueries];
  log.step(`検索クエリ ${queries.length} 件`);

  // --- 3. ハイブリッド検索 -------------------------------------------
  const sourcePriority = {};
  config.sources.forEach((s, i) => { sourcePriority[s.id] = s.priority ?? (1 - i * 0.05); });
  const results = await hybridSearch(store, {
    queries, config, filter, k: preset.final,
    kindPriors: task.kindPriors, sourcePriority,
  });
  log.step(`検索結果 ${results.length} チャンク`);

  // --- 4. 静的事実（LLM 非依存） -------------------------------------
  let staticText = '';
  let staticSummary = { total: 0, bySeverity: {}, byRule: {} };
  let findings = [];
  if (task.staticNeeds.findings || task.staticNeeds.facts || task.staticNeeds.endpoints) {
    const docs = await allDocs(config, sourceIds);
    const evidencePaths = new Set(results.map((r) => `${r.sourceId}:${r.path}`));
    if (task.staticNeeds.findings) {
      findings = scanAll(docs, { minSeverity: opts.minSeverity || 'low' });
      staticSummary = summarize(findings);
      // 証拠に含まれるファイルの検出を優先し、残りは重大度順に補充
      const inEvidence = findings.filter((f) => evidencePaths.has(`${f.sourceId}:${f.path}`));
      const rest = findings.filter((f) => !evidencePaths.has(`${f.sourceId}:${f.path}`));
      findings = [...inEvidence, ...rest].slice(0, 120);
    }
    staticText = renderStaticFacts({
      findings,
      facts: task.staticNeeds.facts ? projectFacts(docs).slice(0, 60) : [],
      endpoints: task.staticNeeds.endpoints ? extractEndpoints(docs, 120) : [],
    }, config.budget.staticFactsTokens);
  }

  // --- 5. プロンプト構築 ---------------------------------------------
  const schema = envelopeSchema(task.itemTypes);
  const headerTokens = estimateTokens(SYSTEM_CONTRACT + task.instruction + staticText + instruction) + 800;
  const pack = buildEvidencePack(results, {
    budgetTokens: preset.evidenceTokens ?? config.budget.evidenceTokens,
    headerTokens: 0,
    redact: config.security?.redactSecrets !== false,
  });
  if (pack.redactedCount) log.warn(`証拠から ${pack.redactedCount} 箇所のシークレットを墨消ししました (${pack.redactedKinds.join(', ')})`);
  const evidenceBlock = renderEvidenceBlock(pack);

  const systemStatic = SYSTEM_CONTRACT;
  const systemDynamic = [
    task.instruction,
    '',
    '# item.type に使える値',
    task.itemTypes.map((t) => `- ${t}`).join('\n'),
    '',
    `# 使用可能な証拠 ID`,
    pack.items.length ? `E1 〜 E${pack.items.length}（これ以外の ID を書くと棄却されます）` : '（証拠なし）',
  ].join('\n');

  const cacheableUser = [
    '# 一次資料（証拠）',
    '以下が今回参照できる資料のすべてです。ここに無い情報は「不明」として扱ってください。',
    '',
    evidenceBlock,
    ...(staticText ? ['', '# 機械的解析の結果（参考。これ自体は証拠 ID を持たないため、引用する場合は該当する証拠 ID を探して付けてください）', '', staticText] : []),
  ].join('\n');

  const userPrompt = [
    '# 依頼',
    instruction,
    '',
    '# 出力',
    '上記の依頼に対し、契約とタスク指示に従って JSON を出力してください。',
    'item の id は I1, I2, ... の連番にしてください。',
  ].join('\n');

  const promptTokens = estimateTokens(systemStatic) + estimateTokens(systemDynamic) + estimateTokens(cacheableUser) + estimateTokens(userPrompt);
  const meta = {
    startedAt,
    project: config.project,
    effort,
    provider: config.llm.provider,
    model: modelOverride || config.llm.model,
    promptHash: taskPromptHash(taskId),
    indexKey: store.manifest.indexKey,
    indexChunks: store.N,
    queries,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    repairs: 0,
    estimatedPromptTokens: promptTokens,
  };
  const prompt = { systemStatic, systemDynamic, evidenceBlock, cacheableUser, userPrompt, schema };

  const runId = `${startedAt.replace(/[:.]/g, '-')}-${taskId}-${shortHash(instruction + meta.indexKey, 6)}`;
  const runDir = path.join(p.runs, runId);

  // --- dry-run: LLM を呼ばずにバンドルを出力（トークン消費ゼロ） -------
  if (dryRun || config.llm.provider === 'dry') {
    const run = { task, instruction, pack, meta, prompt, staticSummary };
    if (save) {
      await fsp.mkdir(runDir, { recursive: true });
      await fsp.writeFile(path.join(runDir, 'bundle.md'), renderBundle(run));
      await fsp.writeFile(path.join(runDir, 'evidence.json'), JSON.stringify(pack, null, 2));
      await fsp.writeFile(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));
    }
    return { dryRun: true, runId, runDir, pack, meta, prompt, staticSummary, markdown: renderBundle(run) };
  }

  if (config.security?.allowLlmUpload === false) {
    throw new Error(
      'security.allowLlmUpload=false のため、資料本文を LLM API に送信する操作をブロックしました。\n' +
      '証拠収集のみ行う場合は --dry-run を使用してください（外部送信は発生しません）。');
  }
  if (promptTokens > config.budget.maxTotalTokensPerRun) {
    throw new Error(`推定プロンプト ${promptTokens} トークンが上限 ${config.budget.maxTotalTokensPerRun} を超えます。--effort low か budget.evidenceTokens を調整してください。`);
  }

  // --- 6. 推論 + 機械検証の修復ループ ---------------------------------
  const provider = createProvider(config.llm);
  let attempt = 0;
  let lastVerification = null;
  let result = null;
  let repairNote = '';
  const maxRepairs = config.budget.maxRepairs ?? 2;

  while (attempt <= maxRepairs) {
    const res = await provider.complete({
      systemStatic, systemDynamic, cacheableUser,
      user: attempt === 0 ? userPrompt : `${userPrompt}\n\n${repairNote}`,
      schema, maxTokens: config.llm.maxOutputTokens, model: modelOverride,
    });
    meta.usage.input += res.usage.input;
    meta.usage.output += res.usage.output;
    meta.usage.cacheRead += res.usage.cacheRead;
    meta.usage.cacheWrite += res.usage.cacheWrite;

    const v = verify(res.json, { pack, schema, policy: config.policy, taskId });
    lastVerification = v;
    result = v.cleaned;
    log.step(`検証 (試行 ${attempt + 1}): 採用 ${v.stats.itemsAccepted} / 棄却 ${v.stats.itemsRejected} / 違反 ${v.stats.hardViolations}`);
    if (v.ok || attempt === maxRepairs) break;
    repairNote = renderViolations(v.violations);
    meta.repairs = ++attempt;
  }

  meta.finishedAt = new Date().toISOString();
  meta.egress = egressSummary();
  meta.redacted = { count: pack.redactedCount || 0, kinds: pack.redactedKinds || [] };
  const run = { task, instruction, result, pack, verification: lastVerification, meta, prompt, staticSummary };
  const markdown = renderMarkdown(run);

  if (save) {
    await fsp.mkdir(runDir, { recursive: true });
    await Promise.all([
      fsp.writeFile(path.join(runDir, 'report.md'), markdown),
      fsp.writeFile(path.join(runDir, 'result.json'), JSON.stringify({ instruction, task: taskId, meta, verification: lastVerification, result }, null, 2)),
      fsp.writeFile(path.join(runDir, 'evidence.json'), JSON.stringify(pack, null, 2)),
      fsp.writeFile(path.join(runDir, 'static.json'), JSON.stringify({ summary: staticSummary, findings }, null, 2)),
    ]);
  }
  return { dryRun: false, runId, runDir, markdown, result, pack, meta, verification: lastVerification, staticSummary };
}
