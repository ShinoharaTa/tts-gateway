/**
 * 合成の流れ: 前処理の前段（spoken.ts。NFKC・URL とメールの削除）→ 読み辞書（readings.ts）→ 前処理の後段（記号の規則）→ 文分割 → エンジン（1 文ずつ）→ 無音処理・連結・音量 → エンコード。
 * キャッシュ（cache.ts）と待ち行列（queue.ts）もここでつなぐ。
 */
import { createHash } from 'node:crypto';
import { ApiError, invalid, notFound } from './errors.ts';
import type { AudioCache } from './cache.ts';
import { CONTENT_TYPES, DEFAULT_BITRATES, encode, outputSampleRate } from './audio/encode.ts';
import { applyGain, concat, samplesToMs, silence, trimSilence } from './audio/pcm.ts';
import type { Engine } from './engines/types.ts';
import type { ModelRecord, Registry } from './models/registry.ts';
import type { SynthQueue } from './queue.ts';
import type { SettingsStore } from './settings.ts';
import type { Dictionary, Hit, UnknownWord } from './text/readings.ts';
import { afterReadings, beforeReadings } from './text/spoken.ts';
import { charCount, validateSynthRequest, type SynthRequest } from './validate.ts';

// ---- 文分割 ----

const SENTENCE_END_RE = /[。！？!?]/;
const SOFT_BREAK_RE = /[、，, 　]/;
/** 読める文字（文字か数字）を含むか */
const SPEAKABLE_RE = /[\p{L}\p{N}]/u;
/** String.prototype.trim が落とす文字（\s と同じ集合） */
const SPACE_RE = /^\s$/;

/**
 * 文に分ける。「。！？!?」の後（記号は前の文に付ける）と改行で切り、maxChars を超える文は
 * 上限より前の最後の読点・空白の後で切る（無ければ上限で切る）。読める文字の無い断片は捨てる
 */
export const splitSentences = (text: string, maxChars: number): string[] => {
  const out: string[] = [];
  const emit = (chars: readonly string[], from: number, to: number): void => {
    const s = chars.slice(from, to).join('').trim();
    if (s && SPEAKABLE_RE.test(s)) out.push(s);
  };
  // chars[from, to) を 1 文として出す。文字列を作り直さず位置だけ進める（長い文でも線形時間）。前後の空白は trim と同じく落とす
  const push = (chars: readonly string[], from: number, to: number): void => {
    while (from < to && SPACE_RE.test(chars[from]!)) from++;
    while (to > from && SPACE_RE.test(chars[to - 1]!)) to--;
    while (to - from > maxChars) {
      let cut = -1;
      for (let i = maxChars - 1; i > 0; i--) {
        if (SOFT_BREAK_RE.test(chars[from + i]!)) {
          cut = i + 1;
          break;
        }
      }
      if (cut <= 0) cut = maxChars;
      emit(chars, from, from + cut);
      from += cut;
      while (from < to && SPACE_RE.test(chars[from]!)) from++;
    }
    emit(chars, from, to);
  };
  for (const line of text.split(/\r?\n/)) {
    let start = 0;
    const chars = [...line];
    for (let i = 0; i < chars.length; i++) {
      // 「！？」の連なり（？！ など）は 1 つの文末として扱う
      if (SENTENCE_END_RE.test(chars[i]!) && !SENTENCE_END_RE.test(chars[i + 1] ?? '')) {
        push(chars, start, i + 1);
        start = i + 1;
      }
    }
    push(chars, start, chars.length);
  }
  return out;
};

// ---- 前処理と辞書 ----

export type Prepared = { spoken: string; sentences: string[]; hits: Hit[]; unknownWords: UnknownWord[] };

/** 前処理と辞書を通した後の文は、text の上限（TTS_MAX_CHARS）のこの倍まで */
export const SPOKEN_CHARS_FACTOR = 3;

/** maxChars: text の上限（TTS_MAX_CHARS）。前処理と辞書の後の文が maxChars × SPOKEN_CHARS_FACTOR 字を超えたら 413 */
export const prepareText = (
  req: Pick<SynthRequest, 'text' | 'preprocess' | 'dictionary' | 'readings' | 'maxSentenceChars'>,
  dict: Dictionary,
  maxChars: number,
): Prepared => {
  // 辞書は記号の規則より先に当てる（GPT-4o・COVID-19 を崩す前に）。normalize と synthesize は同じ順
  const pre = req.preprocess ? beforeReadings(req.text) : req.text.normalize('NFKC');
  const readings = dict.withRequest(req.readings);
  const replaced = req.dictionary ? readings.apply(pre) : pre;
  const spoken = req.preprocess ? afterReadings(replaced) : replaced;
  const limit = maxChars * SPOKEN_CHARS_FACTOR;
  if (charCount(spoken) > limit)
    throw new ApiError(413, 'text_too_long', `text is longer than ${limit} characters after applying preprocessing and the reading dictionary`, 'text');
  return {
    spoken,
    sentences: splitSentences(spoken, req.maxSentenceChars),
    hits: req.dictionary ? readings.hits([pre]) : [],
    unknownWords: readings.unknownWords([pre]),
  };
};

// ---- キャッシュキー ----

/** キーを並べ替えた JSON（同じ値なら同じ文字列） */
export const canonicalJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

export type RenderParams = {
  format: SynthRequest['format'];
  sampleRate: number;
  bitrate: string | undefined;
  volume: number;
  sentencePauseMs: number;
  leadingSilenceMs: number;
  trailingSilenceMs: number;
  trimSilence: boolean;
};

/** sha256(エンジン id・版、声 id とモデルの sha256、辞書を通した後の文、音声に効くパラメータ、出力形式) */
export const cacheKey = (o: {
  engine: Pick<Engine, 'id' | 'version'>;
  voice: Pick<ModelRecord, 'id' | 'source'>;
  sentences: readonly string[];
  params: RenderParams;
  options: unknown;
}): string =>
  createHash('sha256')
    .update(
      canonicalJson({
        v: 1,
        engine: o.engine.id,
        engineVersion: o.engine.version,
        voice: o.voice.id,
        model: o.voice.source.sha256,
        sentences: o.sentences,
        params: o.params,
        options: o.options,
      }),
    )
    .digest('hex');

// ---- 音声を作る ----

/** 文を順に合成し、無音・連結・音量を経てエンコードする */
export const renderAudio = async (o: {
  engine: Engine;
  voice: ModelRecord;
  sentences: readonly string[];
  params: RenderParams;
  options: Record<string, unknown>;
  signal: AbortSignal;
  ffmpeg: string;
}): Promise<{ audio: Buffer; durationMs: number; sampleRate: number }> => {
  const sr = o.engine.sampleRate;
  const p = o.params;
  const parts: Float32Array[] = [silence(p.leadingSilenceMs, sr)];
  for (const [i, sentence] of o.sentences.entries()) {
    let pcm = await o.engine.synthesize(sentence, o.voice, o.options, o.signal);
    if (p.trimSilence) pcm = trimSilence(pcm, sr);
    if (i > 0) parts.push(silence(p.sentencePauseMs, sr));
    parts.push(pcm);
  }
  parts.push(silence(p.trailingSilenceMs, sr));
  const pcm = applyGain(concat(parts), p.volume);
  const audio = await encode(pcm, sr, { format: p.format, sampleRate: p.sampleRate, bitrate: p.bitrate, ffmpeg: o.ffmpeg });
  return { audio, durationMs: samplesToMs(pcm.length, sr), sampleRate: outputSampleRate(p.format, p.sampleRate) };
};

export type SynthResult = {
  audio: Buffer;
  contentType: string;
  engine: Engine;
  voice: string;
  durationMs: number;
  sampleRate: number;
  synthesisMs: number;
  cache: 'hit' | 'miss' | 'bypass';
  key: string;
};

export type SynthesizerDeps = {
  engines: ReadonlyMap<string, Engine>;
  registry: Registry;
  settings: SettingsStore;
  cache: AudioCache;
  queue: SynthQueue;
  dictionary: Dictionary;
  maxChars: number;
  timeoutSec: number;
  ffmpeg: string;
};

export class Synthesizer {
  private readonly d: SynthesizerDeps;

  constructor(deps: SynthesizerDeps) {
    this.d = deps;
  }

  validate(raw: unknown): SynthRequest {
    return validateSynthRequest(raw, {
      engines: this.d.engines,
      defaultEngine: this.d.settings.get().defaultEngine,
      maxChars: this.d.maxChars,
    });
  }

  /** POST /v1/normalize */
  normalize(raw: unknown): Prepared & { text: string } {
    const req = this.validate(raw);
    const p = prepareText(req, this.d.dictionary, this.d.maxChars);
    return { text: req.text, ...p };
  }

  /** 声を決める。未登録は 404、未取得は 422 */
  resolveVoice(engine: Engine, voiceId: string | undefined): ModelRecord {
    const id = voiceId ?? this.d.settings.get().defaultVoices[engine.id];
    if (!id) throw notFound(`engine ${engine.id} has no default voice`, 'voice');
    const rec = this.d.registry.get(engine.id, id);
    if (!rec) throw notFound(`voice ${id} not found`, 'voice');
    if (rec.status !== 'installed') throw new ApiError(422, 'model_not_installed', `voice ${id} is not installed (${rec.status})`, 'voice');
    return rec;
  }

  /** POST /v1/synthesize */
  async synthesize(raw: unknown): Promise<SynthResult> {
    const req = this.validate(raw);
    const engine = this.d.engines.get(req.engine)!;
    const voice = this.resolveVoice(engine, req.voice);
    const limit = engine.sentenceCharLimit?.(req.options) ?? Infinity;
    const { sentences } = prepareText({ ...req, maxSentenceChars: Math.min(req.maxSentenceChars, limit) }, this.d.dictionary, this.d.maxChars);
    if (sentences.length === 0) throw invalid('text has nothing to read', 'text');

    const params: RenderParams = {
      format: req.format,
      sampleRate: req.sampleRate ?? engine.sampleRate,
      bitrate: req.bitrate ?? DEFAULT_BITRATES[req.format],
      volume: req.volume,
      sentencePauseMs: req.sentencePauseMs,
      leadingSilenceMs: req.leadingSilenceMs,
      trailingSilenceMs: req.trailingSilenceMs,
      trimSilence: req.trimSilence,
    };
    const key = cacheKey({ engine, voice, sentences, params, options: req.options });
    const contentType = CONTENT_TYPES[req.format];
    const useCache = req.cache && this.d.cache.enabled;

    if (useCache) {
      const hit = await this.d.cache.get(key);
      if (hit)
        return {
          audio: hit.data, contentType, engine, voice: voice.id, durationMs: hit.meta.durationMs,
          sampleRate: hit.meta.sampleRate, synthesisMs: 0, cache: 'hit', key,
        };
    }

    // キャッシュを使わない要求は合流しない（毎回作る）
    const { promise } = this.d.queue.run(useCache ? key : undefined, async () => {
      const started = performance.now();
      const ac = new AbortController();
      const timer = setTimeout(
        () => ac.abort(new ApiError(504, 'timeout', `synthesis took longer than ${this.d.timeoutSec}s`)),
        this.d.timeoutSec * 1000,
      );
      try {
        const r = await renderAudio({ engine, voice, sentences, params, options: req.options, signal: ac.signal, ffmpeg: this.d.ffmpeg });
        const synthesisMs = Math.round(performance.now() - started);
        if (useCache) {
          await this.d.cache
            .put(key, r.audio, { contentType, durationMs: r.durationMs, sampleRate: r.sampleRate })
            .catch(e => console.error(`cache put failed: ${(e as Error).message}`));
        }
        return { ...r, synthesisMs };
      } finally {
        clearTimeout(timer);
      }
    });
    const r = await promise;
    return {
      audio: r.audio, contentType, engine, voice: voice.id, durationMs: r.durationMs, sampleRate: r.sampleRate,
      synthesisMs: r.synthesisMs, cache: useCache ? 'miss' : 'bypass', key,
    };
  }
}
