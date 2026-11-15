// ログは必ず stderr へ。stdout は JSON / MCP 用に予約する。
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
// 環境変数の値は利用者が決める。constructor などの prototype のキーが関数を返さないよう、自分のキーだけを見る
const envLevel = process.env.CONTEXT_GRILL_LOG_LEVEL;
let current = (typeof envLevel === 'string' && Object.hasOwn(LEVELS, envLevel)) ? LEVELS[envLevel] : LEVELS.info;

/** --log に指定できる水準名（CLI の検査が参照する） */
export const LOG_LEVEL_NAMES = Object.keys(LEVELS);

// `in` は constructor / toString などの prototype のキーでも真になるため、自分のキーだけを見る
export function setLevel(name) { if (Object.hasOwn(LEVELS, name)) current = LEVELS[name]; }
function emit(level, prefix, args) {
  if (current < LEVELS[level]) return;
  process.stderr.write(prefix + ' ' + args.map(fmt).join(' ') + '\n');
}
function fmt(a) { return typeof a === 'string' ? a : JSON.stringify(a); }

export const log = {
  error: (...a) => emit('error', '[context-grill:error]', a),
  warn: (...a) => emit('warn', '[context-grill:warn] ', a),
  info: (...a) => emit('info', '[context-grill]', a),
  debug: (...a) => emit('debug', '[context-grill:debug]', a),
  step: (...a) => emit('info', '[context-grill] ▸', a),
};
