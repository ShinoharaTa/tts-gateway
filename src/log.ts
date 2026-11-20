/**
 * 構造化ログ。1 件 1 行で、debug / info は stdout、warn / error は stderr に出す。
 *
 * - LOG_FORMAT=text（既定）: `<msg> key=value ...`。時刻とレベルは付けない（journald が付ける）。Error は stack を次の行以降に出す
 * - LOG_FORMAT=json: `{"time","level","service","env"?,"msg",...fields}`。Error は { name, message, stack } にする
 * - LOG_LEVEL 未満は出さない。configureLog の前でも既定値（info・text）で動く
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';
export type LogSink = (stream: 'stdout' | 'stderr', line: string) => void;

type Env = Record<string, string | undefined>;

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const FORMATS: readonly LogFormat[] = ['text', 'json'];
/** fields で上書きさせないキー */
const RESERVED = new Set(['time', 'level', 'service', 'env', 'msg']);

const state = { level: 'info' as LogLevel, format: 'text' as LogFormat, service: 'tts-gateway', env: '' };

const defaultSink: LogSink = (stream, line) => {
  (stream === 'stdout' ? process.stdout : process.stderr).write(`${line}\n`);
};
let sink: LogSink = defaultSink;

/** 環境変数からレベル・形式・サービス名・環境名を決める。不正な値は Error（起動時エラー） */
export const configureLog = (env: Env): void => {
  const level = env.LOG_LEVEL?.trim() || 'info';
  if (!LEVELS.includes(level as LogLevel)) throw new Error(`LOG_LEVEL must be one of ${LEVELS.join(', ')} (got ${JSON.stringify(level)})`);
  const format = env.LOG_FORMAT?.trim() || 'text';
  if (!FORMATS.includes(format as LogFormat)) throw new Error(`LOG_FORMAT must be one of ${FORMATS.join(', ')} (got ${JSON.stringify(format)})`);
  state.level = level as LogLevel;
  state.format = format as LogFormat;
  state.service = env.SERVICE_NAME?.trim() || 'tts-gateway';
  state.env = env.APP_ENV?.trim() ?? '';
};

/** テスト用: 出力先を差し替える。null で元に戻す */
export const setLogSink = (s: LogSink | null): void => {
  sink = s ?? defaultSink;
};

const errorJson = (e: Error): Record<string, unknown> => ({ name: e.name, message: e.message, stack: e.stack });

const textValue = (v: unknown): string => {
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v;
  return JSON.stringify(v) ?? String(v);
};

const format = (level: LogLevel, msg: string, fields: Record<string, unknown>): string => {
  if (state.format === 'json') {
    const out: Record<string, unknown> = { time: new Date().toISOString(), level, service: state.service };
    if (state.env) out.env = state.env;
    out.msg = msg;
    for (const [k, v] of Object.entries(fields)) {
      if (RESERVED.has(k)) continue;
      out[k] = v instanceof Error ? errorJson(v) : v;
    }
    return JSON.stringify(out);
  }
  let line = msg;
  const stacks: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v instanceof Error) stacks.push(v.stack ?? `${v.name}: ${v.message}`);
    else line += ` ${k}=${textValue(v)}`;
  }
  return stacks.length ? `${line}\n${stacks.join('\n')}` : line;
};

const write = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void => {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(state.level)) return;
  sink(level === 'debug' || level === 'info' ? 'stdout' : 'stderr', format(level, msg, fields));
};

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>): void => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>): void => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>): void => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>): void => write('error', msg, fields),
};
