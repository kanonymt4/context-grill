// 日英の語彙ギャップを埋める決定的な用語辞書。
// 索引側ではなく「クエリ側」だけを拡張するので、索引の互換性は壊れない。
// 例: 日本語の設計書で「返金のリトライ」と書かれた仕様に対し、
//     英語で書かれた refundPayment / MAX_RETRY のコードを取りこぼさないようにする。
const PAIRS = [
  ['認証', 'auth authentication login signin credential'],
  ['認可', 'authorization permission acl policy'],
  ['権限', 'permission role privilege scope'],
  ['ログイン', 'login signin authenticate'],
  ['ログアウト', 'logout signout'],
  ['パスワード', 'password passwd credential'],
  ['トークン', 'token jwt bearer accesstoken'],
  ['セッション', 'session cookie'],
  ['暗号', 'encrypt crypto cipher encryption'],
  ['署名', 'signature sign verify hmac'],
  ['ハッシュ', 'hash digest bcrypt argon'],
  ['有効期限', 'expiry expires ttl timeout deadline'],
  ['更新', 'update refresh renew upsert'],
  ['作成', 'create insert new register'],
  ['削除', 'delete remove destroy purge'],
  ['取得', 'get fetch retrieve read list find query'],
  ['検索', 'search query find filter'],
  ['一覧', 'list index all'],
  ['決済', 'payment pay checkout charge billing'],
  ['返金', 'refund reverse chargeback cancel'],
  ['請求', 'invoice billing charge'],
  ['注文', 'order purchase cart'],
  ['在庫', 'stock inventory'],
  ['顧客', 'customer user account client'],
  ['利用者', 'user account'],
  ['通知', 'notification notify alert push mail'],
  ['メール', 'mail email smtp'],
  ['リトライ', 'retry backoff attempt redrive'],
  ['再試行', 'retry backoff attempt'],
  ['タイムアウト', 'timeout deadline abort'],
  ['例外', 'exception error throw raise'],
  ['エラー', 'error exception failure fault'],
  ['失敗', 'fail failure error'],
  ['ログ', 'log logger logging trace'],
  ['監視', 'monitor metrics observability alert'],
  ['計測', 'metrics telemetry instrument'],
  ['キャッシュ', 'cache memoize redis'],
  ['キュー', 'queue sqs kafka worker job'],
  ['非同期', 'async await background job'],
  ['バッチ', 'batch cron scheduler job'],
  ['並列', 'parallel concurrent concurrency'],
  ['排他', 'lock mutex exclusive transaction'],
  ['整合性', 'consistency integrity constraint'],
  ['冪等', 'idempotent idempotency'],
  ['検証', 'validate validation verify check'],
  ['入力', 'input request payload param'],
  ['出力', 'output response result'],
  ['設定', 'config configuration setting env option'],
  ['環境変数', 'env environment variable'],
  ['依存', 'dependency depends import require'],
  ['移行', 'migration migrate upgrade'],
  ['スキーマ', 'schema model table column'],
  ['データベース', 'database db sql table repository'],
  ['テーブル', 'table entity model'],
  ['接続', 'connection connect pool client'],
  ['トランザクション', 'transaction commit rollback'],
  ['インデックス', 'index'],
  ['画面', 'page screen view component ui'],
  ['画像', 'image file upload media'],
  ['アップロード', 'upload multipart file'],
  ['ダウンロード', 'download export'],
  ['帳票', 'report pdf export'],
  ['集計', 'aggregate sum count report'],
  ['テスト', 'test spec assert mock'],
  ['本番', 'production prod live'],
  ['開発', 'development dev local'],
  ['検証環境', 'staging stg qa'],
  ['配信', 'deploy release delivery publish'],
  ['公開', 'public expose publish'],
  ['非公開', 'private internal'],
  ['制限', 'limit throttle ratelimit quota'],
  ['上限', 'max maximum limit cap'],
  ['下限', 'min minimum'],
  ['既定値', 'default fallback'],
  ['仕様', 'spec specification requirement contract'],
  ['要件', 'requirement spec'],
  ['設計', 'design architecture'],
  ['影響範囲', 'impact affected blast radius'],
  ['脆弱性', 'vulnerability cve exploit'],
  ['対策', 'mitigation remediation fix countermeasure'],
  ['注入', 'injection inject sanitize escape'],
  ['改ざん', 'tamper forgery integrity'],
  ['なりすまし', 'spoof impersonate forgery'],
  ['漏洩', 'leak exposure disclosure'],
  ['再現', 'reproduce repro reproduction steps'],
  ['原因', 'cause root cause reason'],
  ['修正', 'fix patch repair'],
  ['回避', 'workaround bypass'],
  ['性能', 'performance latency throughput'],
  ['遅延', 'latency delay slow'],
  ['負荷', 'load stress traffic'],
  ['分岐', 'branch condition if'],
  ['状態', 'state status'],
  ['遷移', 'transition workflow flow'],
  ['webhook', 'ウェブフック 通知 コールバック'],
  ['api', 'エンドポイント インタフェース'],
];

const FORWARD = new Map();  // 日本語 → 英語群
const BACKWARD = new Map(); // 英語 → 日本語群
for (const [ja, en] of PAIRS) {
  const enTerms = en.split(/\s+/).filter(Boolean);
  FORWARD.set(ja, enTerms);
  for (const e of enTerms) {
    if (!BACKWARD.has(e)) BACKWARD.set(e, []);
    if (!BACKWARD.get(e).includes(ja)) BACKWARD.get(e).push(ja);
  }
}

const CJK = /[぀-ヿ㐀-䶿一-鿿]/;

/**
 * クエリ文字列から、辞書に基づく追加語を返す（重み付き）。
 * 完全に静的な辞書なので、いつ・どのモデルで実行しても同じ拡張になる。
 */
export function bridgeTerms(query) {
  const added = new Map();
  const lower = query.toLowerCase();
  for (const [ja, enTerms] of FORWARD) {
    if (CJK.test(ja) ? query.includes(ja) : new RegExp(`\\b${ja}\\b`).test(lower)) {
      for (const e of enTerms) added.set(e, Math.max(added.get(e) || 0, 0.55));
    }
  }
  for (const [en, jaTerms] of BACKWARD) {
    if (en.length >= 3 && new RegExp(`\\b${en}`).test(lower)) {
      for (const j of jaTerms) {
        added.set(j, Math.max(added.get(j) || 0, 0.5));
        if (j.length >= 2) for (let i = 0; i + 1 < j.length; i++) added.set(j.slice(i, i + 2), 0.45);
      }
    }
  }
  return added;
}

export const GLOSSARY_SIZE = PAIRS.length;
