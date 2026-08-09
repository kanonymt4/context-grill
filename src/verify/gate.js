import { validate } from '../llm/jsonschema.js';

const SPECULATIVE = [
  'おそらく', 'と思われる', 'と思います', '推測', 'かもしれ', '一般的に', '通常は', '恐らく', 'であろう', 'と考えられます',
  'probably', 'likely', 'presumably', 'typically', 'usually', 'i think', 'it seems', 'appears to be', 'might be',
];

const norm = (s) => String(s).replace(/\r\n/g, '\n').replace(/[ \t　]+/g, ' ').replace(/\n[ \t]*/g, '\n').trim();

/**
 * 検証ゲート。ここを通らない主張は最終レポートに載らない。
 * モデル固有の饒舌さ・自信過剰を機械的に均すことで、モデル間の品質差を吸収する。
 */
export function verify(result, { pack, schema, policy, taskId }) {
  const violations = [];
  const evidenceMap = new Map(pack.items.map((e) => [e.id, e]));
  const add = (code, where, message, fixHint) => violations.push({ code, where, message, fixHint });

  if (!result || typeof result !== 'object') {
    add('E_NO_JSON', '$', 'JSON を取得できませんでした', 'スキーマ通りの JSON のみを出力してください');
    return { ok: false, violations, cleaned: null, stats: {} };
  }

  for (const e of validate(schema, result)) add('E_SCHEMA', '$', e, 'スキーマに厳密に従ってください');

  const items = Array.isArray(result.items) ? result.items : [];
  const seenIds = new Set();
  const rejected = [];
  const accepted = [];
  let quotesChecked = 0, quotesFailed = 0;

  for (const [i, it] of items.entries()) {
    const where = `items[${i}]${it?.id ? ` (${it.id})` : ''}`;
    const problems = [];

    if (!it || typeof it !== 'object') { add('E_ITEM', where, 'item がオブジェクトではありません'); continue; }
    if (it.id) {
      if (seenIds.has(it.id)) problems.push(['E_DUP_ID', `item id ${it.id} が重複しています`, 'id は一意にしてください']);
      seenIds.add(it.id);
    }

    const ev = Array.isArray(it.evidence) ? it.evidence : [];
    if (policy.requireCitations && ev.length < (policy.minEvidencePerItem ?? 1)) {
      problems.push(['E_NO_EVIDENCE', `証拠 ID が ${policy.minEvidencePerItem ?? 1} 個未満です`, '証拠がないなら item を消して open_questions に移してください']);
    }
    const unknown = ev.filter((id) => !evidenceMap.has(id));
    if (unknown.length) {
      problems.push(['E_BAD_EVIDENCE', `存在しない証拠 ID: ${unknown.join(', ')}`, `使える証拠 ID は ${pack.items.length ? pack.items[0].id + '〜' + pack.items[pack.items.length - 1].id : 'なし'} です`]);
    }
    for (const id of (it.contradicting_evidence || [])) {
      if (!evidenceMap.has(id)) problems.push(['E_BAD_EVIDENCE', `contradicting_evidence に存在しない ID: ${id}`, '実在する証拠 ID のみ使ってください']);
    }

    // 逐語引用の実在照合（ハルシネーション検出の要）
    for (const q of (it.quotes || [])) {
      quotesChecked++;
      const src = evidenceMap.get(q.evidence);
      if (!src) { quotesFailed++; problems.push(['E_QUOTE_SRC', `quote の証拠 ID ${q.evidence} が存在しません`, '実在する証拠から引用してください']); continue; }
      if (policy.requireVerbatimQuote && !norm(src.text).includes(norm(q.text))) {
        quotesFailed++;
        problems.push(['E_QUOTE_MISMATCH', `${q.evidence} の本文に一致しない引用があります: "${String(q.text).slice(0, 80)}"`, '引用は証拠本文からコピーしてください（要約は statement に）']);
      }
    }

    if (policy.forbidSpeculativeLanguage) {
      const blob = `${it.title ?? ''} ${it.statement ?? ''} ${it.remediation ?? ''}`.toLowerCase();
      const hit = SPECULATIVE.filter((w) => blob.includes(w.toLowerCase()));
      if (hit.length && it.confidence === 'high') {
        problems.push(['E_SPECULATION', `推測表現(${hit.join(', ')})を含む item の confidence が high です`, '推測表現を削るか confidence を下げるか open_questions に移してください']);
      } else if (hit.length) {
        problems.push(['W_SPECULATION', `推測表現を含みます: ${hit.join(', ')}`, '断定できない内容は open_questions に移してください']);
      }
    }

    const hard = problems.filter(([c]) => c.startsWith('E_'));
    for (const [code, msg, fix] of problems) add(code, where, msg, fix);
    if (hard.length) rejected.push({ item: it, reasons: hard.map(([c, m]) => `${c}: ${m}`) });
    else accepted.push(it);
  }

  for (const [i, c] of (result.contradictions || []).entries()) {
    const bad = (c.evidence || []).filter((id) => !evidenceMap.has(id));
    if (bad.length) add('E_BAD_EVIDENCE', `contradictions[${i}]`, `存在しない証拠 ID: ${bad.join(', ')}`, '実在する証拠 ID のみ使ってください');
  }
  for (const [i, a] of (result.next_actions || []).entries()) {
    const bad = (a.evidence || []).filter((id) => !evidenceMap.has(id));
    if (bad.length) add('W_BAD_EVIDENCE', `next_actions[${i}]`, `存在しない証拠 ID: ${bad.join(', ')}`, '実在する証拠 ID のみ使ってください');
  }
  if (!Array.isArray(result.open_questions)) {
    add('E_SCHEMA', '$.open_questions', 'open_questions は配列である必要があります');
  }

  const hardCount = violations.filter((v) => v.code.startsWith('E_')).length;
  const cleaned = {
    ...result,
    items: policy.dropUnverifiedItems ? accepted : items,
    _rejected: rejected,
  };
  return {
    ok: hardCount === 0,
    violations,
    cleaned,
    stats: {
      itemsTotal: items.length,
      itemsAccepted: accepted.length,
      itemsRejected: rejected.length,
      quotesChecked,
      quotesFailed,
      hardViolations: hardCount,
      softViolations: violations.length - hardCount,
      citedEvidence: new Set(items.flatMap((i) => i?.evidence || []).filter((id) => evidenceMap.has(id))).size,
      evidenceOffered: pack.items.length,
    },
  };
}

/** 修復ループ用の指示文 */
export function renderViolations(violations, limit = 25) {
  const hard = violations.filter((v) => v.code.startsWith('E_'));
  const soft = violations.filter((v) => !v.code.startsWith('E_'));
  const fmt = (v) => `- [${v.code}] ${v.where}: ${v.message}${v.fixHint ? `\n  → ${v.fixHint}` : ''}`;
  return [
    '# 検証違反（機械的検証の結果）',
    ...hard.slice(0, limit).map(fmt),
    ...(soft.length ? ['', '# 警告'] : []),
    ...soft.slice(0, 10).map(fmt),
    '',
    '上記をすべて解消した JSON を再出力してください。',
    '重要: 違反した item は「削除する」か「正しい証拠 ID を付ける」かのどちらかで解消してください。',
    '新しい推測を追加して埋めることは禁止です。証拠が足りないものは open_questions に移してください。',
  ].join('\n');
}
