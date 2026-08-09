// ログは必ず stderr へ。stdout は JSON / MCP 用に予約する。
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
let current = LEVELS[process.env.GROUNDED_LOG_LEVEL] ?? LEVELS.info;

export function setLevel(name) { if (name in LEVELS) current = LEVELS[name]; }
function emit(level, prefix, args) {
  if (current < LEVELS[level]) return;
  process.stderr.write(prefix + ' ' + args.map(fmt).join(' ') + '\n');
}
function fmt(a) { return typeof a === 'string' ? a : JSON.stringify(a); }

export const log = {
  error: (...a) => emit('error', '[grounded:error]', a),
  warn: (...a) => emit('warn', '[grounded:warn] ', a),
  info: (...a) => emit('info', '[grounded]', a),
  debug: (...a) => emit('debug', '[grounded:debug]', a),
  step: (...a) => emit('info', '[grounded] ▸', a),
};
