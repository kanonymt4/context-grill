const SEV_MARK = { critical: '🔴 critical', high: '🟠 high', medium: '🟡 medium', low: '🔵 low', info: '⚪ info' };
const CONF_MARK = { high: '確度: 高', medium: '確度: 中', low: '確度: 低' };

/** 最終レポート（Markdown）。すべての主張に一次資料へのリンクが付く。 */
export function renderMarkdown(run) {
  const { task, instruction, result, pack, verification, meta, staticSummary } = run;
  const L = [];
  const evMap = new Map(pack.items.map((e) => [e.id, e]));
  const cite = (ids = []) => ids.map((id) => {
    const e = evMap.get(id);
    if (!e) return `\`${id}\``;
    return e.url ? `[${id}](${e.url})` : `\`${id}\` (${e.label})`;
  }).join(' , ');

  L.push(`# ${task.label}: ${instruction}`);
  L.push('');
  L.push('> このレポートの全ての主張は、下部の「証拠一覧」にある一次資料に紐付いています。');
  L.push('> 証拠のない記述は機械的に除去されています（除去分は「棄却された主張」を参照）。');
  L.push('');
  L.push('## 実行メタデータ');
  L.push('');
  L.push('| 項目 | 値 |');
  L.push('| --- | --- |');
  L.push(`| 実行日時 | ${meta.startedAt} |`);
  L.push(`| プロジェクト | ${meta.project} |`);
  L.push(`| タスク | \`${task.id}\` (${task.label}) |`);
  L.push(`| 深さ (effort) | ${meta.effort} |`);
  L.push(`| モデル | ${meta.provider} / ${meta.model} |`);
  L.push(`| プロンプト版 | \`${meta.promptHash}\` |`);
  L.push(`| 索引キー | \`${String(meta.indexKey).slice(0, 12)}\` (${meta.indexChunks} チャンク) |`);
  L.push(`| 検索クエリ数 | ${meta.queries.length} |`);
  L.push(`| 提示した証拠 | ${pack.items.length} 件 / ${pack.tokens} トークン (除外 ${pack.droppedCount} 件) |`);
  L.push(`| 引用された証拠 | ${verification.stats.citedEvidence} 件 |`);
  L.push(`| 逐語引用の照合 | ${verification.stats.quotesChecked - verification.stats.quotesFailed} / ${verification.stats.quotesChecked} 一致 |`);
  L.push(`| 採用 / 棄却された主張 | ${verification.stats.itemsAccepted} / ${verification.stats.itemsRejected} |`);
  L.push(`| トークン使用量 | 入力 ${meta.usage.input} (キャッシュ読取 ${meta.usage.cacheRead}) / 出力 ${meta.usage.output} |`);
  L.push(`| 修復ラウンド | ${meta.repairs} |`);
  L.push('');

  L.push('## 要約');
  L.push('');
  L.push(result.summary || '(なし)');
  L.push('');

  if (staticSummary && staticSummary.total > 0) {
    L.push('## 静的解析サマリ（LLM 非依存・毎回同一）');
    L.push('');
    L.push(Object.entries(staticSummary.bySeverity).map(([k, v]) => `${SEV_MARK[k] || k}: ${v}`).join(' / '));
    L.push('');
  }

  const items = result.items || [];
  if (items.length) {
    L.push('## 調査結果');
    L.push('');
    const byType = new Map();
    for (const it of items) {
      if (!byType.has(it.type)) byType.set(it.type, []);
      byType.get(it.type).push(it);
    }
    for (const [type, group] of byType) {
      L.push(`### ${type}`);
      L.push('');
      for (const it of group) {
        const sev = it.severity ? `${SEV_MARK[it.severity] || it.severity} · ` : '';
        L.push(`#### ${it.id}. ${it.title}`);
        L.push('');
        L.push(`${sev}${CONF_MARK[it.confidence] || it.confidence}${it.cwe ? ` · ${it.cwe}` : ''}`);
        L.push('');
        L.push(it.statement);
        if (it.impact) { L.push(''); L.push(`**影響**: ${it.impact}`); }
        if (it.remediation) { L.push(''); L.push(`**対応方針**: ${it.remediation}`); }
        for (const q of (it.quotes || [])) {
          const e = evMap.get(q.evidence);
          L.push('');
          L.push(`> \`${e ? e.label : q.evidence}\``);
          L.push('```');
          L.push(q.text);
          L.push('```');
        }
        L.push('');
        L.push(`**根拠**: ${cite(it.evidence)}`);
        if (it.contradicting_evidence?.length) L.push(`**反証候補**: ${cite(it.contradicting_evidence)}`);
        L.push('');
      }
    }
  } else {
    L.push('## 調査結果');
    L.push('');
    L.push('証拠から裏付けられる主張はありませんでした。「未解決の論点」を参照してください。');
    L.push('');
  }

  if (result.contradictions?.length) {
    L.push('## 資料間の矛盾');
    L.push('');
    for (const c of result.contradictions) L.push(`- ${c.description}\n  - 根拠: ${cite(c.evidence)}`);
    L.push('');
  }

  L.push('## 未解決の論点（証拠が不足している事項）');
  L.push('');
  if (result.open_questions?.length) {
    for (const q of result.open_questions) {
      L.push(`- **${q.question}**`);
      L.push(`  - 未解決の理由: ${q.why_unresolved}`);
      L.push(`  - 次に見るべき場所: ${q.where_to_look}`);
    }
  } else L.push('- なし');
  L.push('');

  if (result.next_actions?.length) {
    L.push('## 推奨アクション');
    L.push('');
    for (const a of result.next_actions) {
      L.push(`- ${a.action}${a.rationale ? ` — ${a.rationale}` : ''}${a.evidence?.length ? ` (${cite(a.evidence)})` : ''}`);
    }
    L.push('');
  }

  if (result._rejected?.length) {
    L.push('## 棄却された主張（検証で不合格）');
    L.push('');
    L.push('以下はモデルが出力したものの、証拠との照合に失敗したため本文から除外されました。');
    L.push('');
    for (const r of result._rejected) {
      L.push(`- ~~${r.item.title || '(無題)'}~~`);
      for (const reason of r.reasons) L.push(`  - ${reason}`);
    }
    L.push('');
  }

  L.push('## 証拠一覧');
  L.push('');
  L.push('| ID | ソース | 場所 | 種別 | リンク |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const e of pack.items) {
    L.push(`| ${e.id} | ${e.sourceId} | \`${e.path}\`${e.kind === 'code' ? `:${e.start}-${e.end}` : ''} | ${e.kind} | ${e.url ? `[開く](${e.url})` : '-'} |`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push(`_generated by grounded — 同じ索引キー・同じプロンプト版なら、モデルを変えても提示される証拠は同一です。_`);
  return L.join('\n');
}

/** LLM を呼ばずに、そのまま任意のチャットに貼れるバンドルを作る（--dry-run） */
export function renderBundle(run) {
  const { systemStatic, systemDynamic, evidenceBlock, userPrompt, schema } = run.prompt;
  return [
    '<!-- grounded dry-run bundle -->',
    '# SYSTEM', '', '```', systemStatic, '', systemDynamic, '```', '',
    '# EVIDENCE', '', '```xml', evidenceBlock, '```', '',
    '# USER', '', '```', userPrompt, '```', '',
    '# OUTPUT JSON SCHEMA', '', '```json', JSON.stringify(schema, null, 2), '```',
  ].join('\n');
}
