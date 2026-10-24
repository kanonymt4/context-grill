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
    // 後段（render など）が null で落ちないよう、空の envelope と 0 埋めの stats を返す
    return {
      ok: false,
      violations,
      cleaned: { summary: '', items: [], open_questions: [], contradictions: [], next_actions: [], _rejected: [] },
      stats: {
        itemsTotal: 0, itemsAccepted: 0, itemsRejected: 0, quotesChecked: 0, quotesFailed: 0,
        hardViolations: violations.length, softViolations: 0, citedEvidence: 0, evidenceOffered: pack.items.length,
      },
    };
  }

  for (const e of validate(schema, result)) add('E_SCHEMA', '$', e, 'スキーマに厳密に従ってください');

  const items = Array.isArray(result.items) ? result.items : [];
  // item 単位のスキーマ検査用。違反メッセージはトップレベルの validate が既に報告しているので、
  // ここでは item の棄却理由にだけ使い、violations には重ねて積まない（第4要素 true = 報告済み）
  const itemSchema = schema?.properties?.items?.items;
  const seenIds = new Set();
  const rejected = [];
  const accepted = [];
  let quotesChecked = 0, quotesFailed = 0;

  for (const [i, it] of items.entries()) {
    const where = `items[${i}]${it?.id ? ` (${it.id})` : ''}`;
    const problems = [];

    if (!it || typeof it !== 'object') { add('E_ITEM', where, 'item がオブジェクトではありません'); continue; }
    for (const e of validate(itemSchema, it, `$.items[${i}]`)) {
      problems.push(['E_SCHEMA', e, 'スキーマに厳密に従ってください', true]);
    }
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
    // 値があるのに型が違うものは、例外にせず違反として報告して検査対象から外す（undefined / null は「無い」扱い）
    let contra = [];
    if (it.contradicting_evidence != null) {
      if (Array.isArray(it.contradicting_evidence)) contra = it.contradicting_evidence;
      else problems.push(['E_SCHEMA', 'contradicting_evidence は配列である必要があります', '証拠 ID の配列にするか、項目を削除してください']);
    }
    for (const id of contra) {
      if (!evidenceMap.has(id)) problems.push(['E_BAD_EVIDENCE', `contradicting_evidence に存在しない ID: ${id}`, '実在する証拠 ID のみ使ってください']);
    }

    // 逐語引用の実在照合（ハルシネーション検出の要）
    let quotes = [];
    if (it.quotes != null) {
      if (Array.isArray(it.quotes)) quotes = it.quotes;
      else problems.push(['E_SCHEMA', 'quotes は配列である必要があります', 'quotes は {evidence, text} の配列にしてください']);
    }
    for (const [qi, q] of quotes.entries()) {
      if (!q || typeof q !== 'object' || Array.isArray(q)) {
        problems.push(['E_SCHEMA', `quotes[${qi}] がオブジェクトではありません`, 'quotes の要素は {evidence, text} のオブジェクトにしてください']);
        continue;
      }
      quotesChecked++;
      const src = evidenceMap.get(q.evidence);
      if (!src) { quotesFailed++; problems.push(['E_QUOTE_SRC', `quote の証拠 ID ${q.evidence} が存在しません`, '実在する証拠から引用してください']); continue; }
      if (ev.length && !ev.includes(q.evidence)) {
        problems.push(['E_QUOTE_NOT_CITED', `quote の証拠 ID ${q.evidence} が item の evidence に含まれていません`, '引用する証拠 ID を evidence にも書いてください']);
      }
      if (norm(q.text) === '') {
        quotesFailed++;
        problems.push(['E_QUOTE_EMPTY', `${q.evidence} の引用が空です`, '引用は証拠本文から実際の文言をコピーしてください']);
      } else if (policy.requireVerbatimQuote && !norm(src.text).includes(norm(q.text))) {
        quotesFailed++;
        problems.push(['E_QUOTE_MISMATCH', `${q.evidence} の本文に一致しない引用があります: "${String(q.text).slice(0, 80)}"`, '引用は証拠本文からコピーしてください（要約は statement に）']);
      }
    }

    if (policy.forbidSpeculativeLanguage) {
      const blob = `${it.title ?? ''} ${it.statement ?? ''} ${it.remediation ?? ''}`.toLowerCase();
      const hit = SPECULATIVE.filter((w) => blob.includes(w.toLowerCase()));
      if (hit.length && String(it.confidence).toLowerCase() === 'high') {
        problems.push(['E_SPECULATION', `推測表現(${hit.join(', ')})を含む item の confidence が high です`, '推測表現を削るか confidence を下げるか open_questions に移してください']);
      } else if (hit.length) {
        problems.push(['W_SPECULATION', `推測表現を含みます: ${hit.join(', ')}`, '断定できない内容は open_questions に移してください']);
      }
    }

    const hard = problems.filter(([c]) => c.startsWith('E_'));
    for (const [code, msg, fix, reported] of problems) if (!reported) add(code, where, msg, fix);
    if (hard.length) rejected.push({ item: it, reasons: hard.map(([c, m]) => `${c}: ${m}`) });
    else accepted.push(it);
  }

  if (policy.forbidSpeculativeLanguage && typeof result.summary === 'string') {
    const lower = result.summary.toLowerCase();
    const hit = SPECULATIVE.filter((w) => lower.includes(w.toLowerCase()));
    // summary には確度が無いので、item と違いハード違反にはしない
    if (hit.length) add('W_SPECULATION', '$.summary', `summary に推測表現を含みます: ${hit.join(', ')}`, '断定できない内容は open_questions に移してください');
  }

  // 配列でない・要素がオブジェクトでない・evidence が配列でない場合は E_SCHEMA にして、その要素の検査は飛ばす
  // 存在しない証拠 ID を持つ contradictions は cleaned から外して _rejected に記録し、next_actions は不正な ID だけを落とす
  const cleanedLists = {};
  const rejectedExtra = [];
  for (const key of ['contradictions', 'next_actions']) {
    const list = result[key];
    if (list == null) continue;
    if (!Array.isArray(list)) {
      add('E_SCHEMA', `$.${key}`, `${key} は配列である必要があります`, 'オブジェクトの配列にしてください');
      continue;
    }
    const kept = [];
    for (const [i, c] of list.entries()) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        add('E_SCHEMA', `${key}[${i}]`, `${key}[${i}] がオブジェクトではありません`, '要素はオブジェクトにしてください');
        kept.push(c);
        continue;
      }
      if (c.evidence != null && !Array.isArray(c.evidence)) {
        add('E_SCHEMA', `${key}[${i}]`, `${key}[${i}].evidence は配列である必要があります`, '証拠 ID の配列にしてください');
        kept.push(c);
        continue;
      }
      const bad = (c.evidence || []).filter((id) => !evidenceMap.has(id));
      if (!bad.length) { kept.push(c); continue; }
      const message = `存在しない証拠 ID: ${bad.join(', ')}`;
      add(key === 'contradictions' ? 'E_BAD_EVIDENCE' : 'W_BAD_EVIDENCE', `${key}[${i}]`, message, '実在する証拠 ID のみ使ってください');
      if (!policy.dropUnverifiedItems) { kept.push(c); continue; }
      if (key === 'contradictions') {
        rejectedExtra.push({ kind: 'contradiction', item: { ...c, title: `(矛盾) ${c.description ?? ''}` }, reasons: [`E_BAD_EVIDENCE: ${message}`] });
      } else {
        kept.push({ ...c, evidence: c.evidence.filter((id) => evidenceMap.has(id)) });
      }
    }
    cleanedLists[key] = kept;
  }
  if (!Array.isArray(result.open_questions)) {
    add('E_SCHEMA', '$.open_questions', 'open_questions は配列である必要があります');
  }

  const hardCount = violations.filter((v) => v.code.startsWith('E_')).length;
  const cleaned = {
    ...result,
    ...cleanedLists,
    items: policy.dropUnverifiedItems ? accepted : items,
    _rejected: [...rejected, ...rejectedExtra],
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
      citedEvidence: new Set(accepted.flatMap((i) => i?.evidence || []).filter((id) => evidenceMap.has(id))).size,
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
