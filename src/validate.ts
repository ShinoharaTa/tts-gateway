/**
 * リクエストの検証（docs/api.md「POST /v1/synthesize」）。未知のフィールド・範囲外・型違いは 400、text の上限超えは 413。
 * エンジン固有のオプション（zenTts など）はそのエンジンの validateOptions に渡す。別のエンジンのキーは 400。
 */
import { ApiError, invalid, notFound } from './errors.ts';
import { DEFAULT_BITRATES, FORMATS, SAMPLE_RATES, type Format } from './audio/encode.ts';
import type { Engine, EngineOptions } from './engines/types.ts';
import { isReading, normalizeSurface } from './text/readings.ts';

// ---- 共通の検査 ----

export const checkObject = (v: unknown, field: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(`${field || 'body'} must be a JSON object`, field || undefined);
  return v as Record<string, unknown>;
};

/** allowed に無いキーがあれば 400 */
export const checkKeys = (obj: Record<string, unknown>, allowed: readonly string[], prefix = ''): void => {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw invalid(`unknown field ${prefix}${key}`, `${prefix}${key}`);
  }
};

export const checkNumber = (v: unknown, field: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${field} must be a number`, field);
  if (v < min || v > max) throw invalid(`${field} must be between ${min} and ${max}`, field);
  return v;
};

export const checkInt = (v: unknown, field: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw invalid(`${field} must be an integer`, field);
  if (v < min || v > max) throw invalid(`${field} must be between ${min} and ${max}`, field);
  return v;
};

export const checkBool = (v: unknown, field: string): boolean => {
  if (typeof v !== 'boolean') throw invalid(`${field} must be a boolean`, field);
  return v;
};

export const checkString = (v: unknown, field: string): string => {
  if (typeof v !== 'string') throw invalid(`${field} must be a string`, field);
  return v;
};

export const checkEnum = <T extends string | number>(v: unknown, field: string, values: readonly T[]): T => {
  if (!values.includes(v as T)) throw invalid(`${field} must be one of ${values.join(', ')}`, field);
  return v as T;
};

// ---- /v1/synthesize・/v1/normalize ----

export const MAX_REQUEST_READINGS = 200;

export type SynthRequest = {
  text: string;
  engine: string;
  voice: string | undefined;
  format: Format;
  sampleRate: number | undefined;
  bitrate: string | undefined;
  volume: number;
  sentencePauseMs: number;
  leadingSilenceMs: number;
  trailingSilenceMs: number;
  trimSilence: boolean;
  maxSentenceChars: number;
  preprocess: boolean;
  dictionary: boolean;
  readings: Record<string, string>;
  cache: boolean;
  /** エンジン固有のオプション（validateOptions を通したもの） */
  options: EngineOptions;
};

const COMMON_FIELDS = [
  'text', 'engine', 'voice', 'format', 'sampleRate', 'bitrate', 'volume', 'sentencePauseMs', 'leadingSilenceMs',
  'trailingSilenceMs', 'trimSilence', 'maxSentenceChars', 'preprocess', 'dictionary', 'readings', 'cache',
] as const;

export type ValidateContext = {
  engines: ReadonlyMap<string, Engine>;
  defaultEngine: string;
  maxChars: number;
};

const BITRATE_RE = /^([1-9]\d{1,2})k$/;

/** text の字数（コードポイント） */
export const charCount = (s: string): number => [...s].length;

export const validateSynthRequest = (raw: unknown, ctx: ValidateContext): SynthRequest => {
  const body = checkObject(raw, '');
  const optionKeys = [...ctx.engines.values()].map(e => e.optionsKey);
  checkKeys(body, [...COMMON_FIELDS, ...optionKeys]);

  if (body.text === undefined) throw invalid('text is required', 'text');
  const text = checkString(body.text, 'text');
  if (text.trim() === '') throw invalid('text must not be empty', 'text');
  if (charCount(text) > ctx.maxChars) throw new ApiError(413, 'text_too_long', `text must be at most ${ctx.maxChars} characters`, 'text');

  const engineId = body.engine === undefined ? ctx.defaultEngine : checkString(body.engine, 'engine');
  const engine = ctx.engines.get(engineId);
  if (!engine) throw notFound(`engine ${engineId} not found`, 'engine');

  for (const other of ctx.engines.values()) {
    if (other !== engine && body[other.optionsKey] !== undefined)
      throw invalid(`${other.optionsKey} is for engine ${other.id}, not ${engine.id}`, other.optionsKey);
  }

  const voice = body.voice === undefined ? undefined : checkString(body.voice, 'voice');
  if (voice === '') throw invalid('voice must not be empty', 'voice');
  const format = body.format === undefined ? 'wav' : checkEnum(body.format, 'format', FORMATS);
  const sampleRate = body.sampleRate === undefined ? undefined : checkEnum(body.sampleRate, 'sampleRate', SAMPLE_RATES);

  let bitrate: string | undefined;
  if (body.bitrate !== undefined) {
    if (!(format in DEFAULT_BITRATES)) throw invalid(`bitrate cannot be used with format ${format}`, 'bitrate');
    const b = checkString(body.bitrate, 'bitrate');
    const m = BITRATE_RE.exec(b);
    if (!m || Number(m[1]) < 16 || Number(m[1]) > 320) throw invalid('bitrate must be between 16k and 320k (e.g. "128k")', 'bitrate');
    bitrate = `${Number(m[1])}k`;
  }

  const num = (key: string, def: number, min: number, max: number): number =>
    body[key] === undefined ? def : checkNumber(body[key], key, min, max);
  const int = (key: string, def: number, min: number, max: number): number =>
    body[key] === undefined ? def : checkInt(body[key], key, min, max);
  const bool = (key: string, def: boolean): boolean => (body[key] === undefined ? def : checkBool(body[key], key));

  const readings: Record<string, string> = {};
  if (body.readings !== undefined) {
    const r = checkObject(body.readings, 'readings');
    const entries = Object.entries(r);
    if (entries.length > MAX_REQUEST_READINGS) throw invalid(`readings must have at most ${MAX_REQUEST_READINGS} entries`, 'readings');
    for (const [surface, reading] of entries) {
      const field = `readings.${surface}`;
      checkSurface(surface, field);
      if (typeof reading !== 'string' || !isReading(reading.trim()))
        throw invalid(`${field} must be katakana (with ー・ and spaces)`, field);
      readings[surface] = reading.trim();
    }
  }

  return {
    text,
    engine: engine.id,
    voice,
    format,
    sampleRate,
    bitrate,
    volume: num('volume', 0, -20, 12),
    sentencePauseMs: int('sentencePauseMs', 250, 0, 3000),
    leadingSilenceMs: int('leadingSilenceMs', 0, 0, 3000),
    trailingSilenceMs: int('trailingSilenceMs', 0, 0, 3000),
    trimSilence: bool('trimSilence', true),
    maxSentenceChars: int('maxSentenceChars', 120, 20, 120),
    preprocess: bool('preprocess', true),
    dictionary: bool('dictionary', true),
    readings,
    cache: bool('cache', true),
    options: engine.validateOptions(body[engine.optionsKey]),
  };
};

/** 読み辞書の語の形（空でない、100 字以内、タブ・改行を含まない、# で始まらない） */
export const MAX_SURFACE_CHARS = 100;

export const checkSurface = (surface: string, field: string): string => {
  const s = normalizeSurface(surface);
  if (!s) throw invalid(`${field}: surface must not be empty`, field);
  if (charCount(s) > MAX_SURFACE_CHARS) throw invalid(`${field}: surface must be at most ${MAX_SURFACE_CHARS} characters`, field);
  if (/[\t\r\n]/.test(surface)) throw invalid(`${field}: surface must not contain tabs or line breaks`, field);
  // readings.tsv では # で始まる行はコメントになり、再起動で消える
  if (s.startsWith('#')) throw invalid(`${field}: surface must not start with #`, field);
  return s;
};
