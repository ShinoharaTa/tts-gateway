/**
 * 合成の流れ: 前処理（spoken.ts）→ 読み辞書（readings.ts）→ 文分割 → エンジン（1 文ずつ）→ 無音処理・連結・音量 → エンコード。
 * キャッシュ（cache.ts）と待ち行列（queue.ts）もここでつなぐ。
 */
import { createHash } from 'node:crypto';
import { ApiError, invalid, notFound } from './errors.ts';
import type { AudioCache } from './cache.ts';
import { CONTENT_TYPES, DEFAULT_BITRATES, encode, ffmpegUnavailable, needsFfmpeg, outputSampleRate, type FfmpegProbe } from './audio/encode.ts';
import { applyGain, concat, samplesToMs, silence, trimSilence } from './audio/pcm.ts';
import { SentenceTooLongError, type Engine } from './engines/types.ts';
import type { ModelRecord, Registry } from './models/registry.ts';
import type { SynthQueue } from './queue.ts';
import type { SettingsStore } from './settings.ts';
import type { Dictionary, Hit, UnknownWord } from './text/readings.ts';
import { toSpoken } from './text/spoken.ts';
import { validateSynthRequest, type SynthRequest } from './validate.ts';

// ---- 文分割 ----

const SENTENCE_END_RE = /[。！？!?]/;
const SOFT_BREAK_RE = /[、，, 　]/;
/** 読める文字（文字か数字）を含むか */
const SPEAKABLE_RE = /[\p{L}\p{N}]/u;

/**
 * 文に分ける。「。！？!?」の後（記号は前の文に付ける）と改行で切り、maxChars を超える文は
 * 上限より前の最後の読点・空白の後で切る（無ければ上限で切る）。読める文字の無い断片は捨てる
 */
export const splitSentences = (text: string, maxChars: number): string[] => {
  const out: string[] = [];
  const push = (s: string): void => {
    let rest = s.trim();
    while ([...rest].length > maxChars) {
      const chars = [...rest];
      let cut = -1;
      for (let i = maxChars - 1; i > 0; i--) {
        if (SOFT_BREAK_RE.test(chars[i]!)) {
          cut = i + 1;
          break;
        }
      }
      if (cut <= 0) cut = maxChars;
      const head = chars.slice(0, cut).join('').trim();
      if (head && SPEAKABLE_RE.test(head)) out.push(head);
      rest = chars.slice(cut).join('').trim();
    }
    if (rest && SPEAKABLE_RE.test(rest)) out.push(rest);
  };
  for (const line of text.split(/\r?\n/)) {
    let start = 0;
    const chars = [...line];
    for (let i = 0; i < chars.length; i++) {
      // 「！？」の連なり（？！ など）は 1 つの文末として扱う
      if (SENTENCE_END_RE.test(chars[i]!) && !SENTENCE_END_RE.test(chars[i + 1] ?? '')) {
        push(chars.slice(start, i + 1).join(''));
        start = i + 1;
      }
    }
    push(chars.slice(start).join(''));
  }
  return out;
};

// ---- 前処理と辞書 ----

export type Prepared = { spoken: string; sentences: string[]; hits: Hit[]; unknownWords: UnknownWord[] };

export const prepareText = (req: Pick<SynthRequest, 'text' | 'preprocess' | 'dictionary' | 'readings' | 'maxSentenceChars'>, dict: Dictionary): Prepared => {
  const pre = req.preprocess ? toSpoken(req.text) : req.text.normalize('NFKC');
  const readings = dict.withRequest(req.readings);
  const spoken = req.dictionary ? readings.apply(pre) : pre;
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

/** 1 回の合成の上限を超えた文を割り直す深さの上限（最大 2^4 = 16 片） */
export const MAX_SPLIT_DEPTH = 4;
/** 割る位置にする文字（読点・空白・中黒） */
const SPLIT_AT_RE = /[、，, 　・]/;

/** 文を 2 つに割る。中央に最も近い読点・空白・中黒の後（無ければ中央のコードポイント境界）。1 文字なら null */
export const splitInHalf = (sentence: string): [string, string] | null => {
  const chars = [...sentence];
  if (chars.length < 2) return null;
  const mid = chars.length / 2;
  let cut = Math.floor(mid);
  let best = Infinity;
  for (let i = 0; i < chars.length - 1; i++) {
    if (SPLIT_AT_RE.test(chars[i]!) && Math.abs(i + 1 - mid) < best) {
      best = Math.abs(i + 1 - mid);
      cut = i + 1;
    }
  }
  return [chars.slice(0, cut).join(''), chars.slice(cut).join('')];
};

/**
 * 1 文を合成する。エンジンの上限を超えたら（SentenceTooLongError）半分に割ってそれぞれ合成し、無音を挟まずにつなぐ。
 * MAX_SPLIT_DEPTH 段割っても、1 文字まで割っても超えるなら 422 unprocessable_text
 */
export const synthesizeSentence = async (
  o: { engine: Engine; voice: ModelRecord; options: Record<string, unknown>; signal: AbortSignal; slot: number },
  sentence: string,
  depth = 0,
): Promise<Float32Array> => {
  try {
    return await o.engine.synthesize(sentence, o.voice, o.options, o.signal, o.slot);
  } catch (e) {
    if (!(e instanceof SentenceTooLongError)) throw e;
    // 中断されたら割り直さない
    o.signal.throwIfAborted();
    const halves = depth < MAX_SPLIT_DEPTH ? splitInHalf(sentence) : null;
    if (!halves) throw new ApiError(422, 'unprocessable_text', 'text contains a word too long to read');
    const parts: Float32Array[] = [];
    for (const half of halves) {
      // 割った片の端の空白は落とし、読める文字の無い片は飛ばす
      const piece = half.trim();
      o.signal.throwIfAborted();
      if (piece && SPEAKABLE_RE.test(piece)) parts.push(await synthesizeSentence(o, piece, depth + 1));
    }
    return concat(parts);
  }
};

/** 文を順に合成し、無音・連結・音量を経てエンコードする */
export const renderAudio = async (o: {
  engine: Engine;
  voice: ModelRecord;
  sentences: readonly string[];
  params: RenderParams;
  options: Record<string, unknown>;
  signal: AbortSignal;
  ffmpeg: string;
  /** 待ち行列のスロット（エンジンの合成プロセス）。省略時は 0 */
  slot?: number;
}): Promise<{ audio: Buffer; durationMs: number; sampleRate: number }> => {
  const sr = o.engine.sampleRate;
  const p = o.params;
  const parts: Float32Array[] = [silence(p.leadingSilenceMs, sr)];
  for (const [i, sentence] of o.sentences.entries()) {
    let pcm = await synthesizeSentence({ ...o, slot: o.slot ?? 0 }, sentence);
    if (p.trimSilence) pcm = trimSilence(pcm, sr);
    if (i > 0) parts.push(silence(p.sentencePauseMs, sr));
    parts.push(pcm);
  }
  parts.push(silence(p.trailingSilenceMs, sr));
  const pcm = applyGain(concat(parts), p.volume);
  const audio = await encode(pcm, sr, { format: p.format, sampleRate: p.sampleRate, bitrate: p.bitrate, ffmpeg: o.ffmpeg, signal: o.signal });
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
  /** ffmpeg の有無（省略時は使える扱い）。使えなければ ffmpeg の要る要求を起動せずに 503 */
  ffmpegProbe?: FfmpegProbe;
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
    const limit = this.d.engines.get(req.engine)!.sentenceCharLimit?.(req.options) ?? Infinity;
    const p = prepareText({ ...req, maxSentenceChars: Math.min(req.maxSentenceChars, limit) }, this.d.dictionary);
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

  /** POST /v1/synthesize。signal はクライアントの切断（待ち行列・エンジン・ffmpeg まで届く。合流中は全員が切断したときだけ止める） */
  async synthesize(raw: unknown, signal?: AbortSignal): Promise<SynthResult> {
    const req = this.validate(raw);
    const engine = this.d.engines.get(req.engine)!;
    const voice = this.resolveVoice(engine, req.voice);
    const limit = engine.sentenceCharLimit?.(req.options) ?? Infinity;
    const { sentences } = prepareText({ ...req, maxSentenceChars: Math.min(req.maxSentenceChars, limit) }, this.d.dictionary);
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

    if (this.d.ffmpegProbe && needsFfmpeg(params.format, params.sampleRate, engine.sampleRate)) {
      if (!(await this.d.ffmpegProbe.get()).available) throw ffmpegUnavailable(this.d.ffmpeg);
    }

    // キャッシュを使わない要求は合流しない（毎回作る）
    // 待ち行列での待ちも timeoutSec まで（要求全体のタイムアウトは実行が始まってから数える）
    const { promise } = this.d.queue.run(useCache ? key : undefined, async (slot, stop) => {
      const started = performance.now();
      const ac = new AbortController();
      const timer = setTimeout(
        () => ac.abort(new ApiError(504, 'timeout', `synthesis took longer than ${this.d.timeoutSec}s`)),
        this.d.timeoutSec * 1000,
      );
      const jobSignal = AbortSignal.any([ac.signal, stop]);
      try {
        const r = await renderAudio({ engine, voice, sentences, params, options: req.options, signal: jobSignal, ffmpeg: this.d.ffmpeg, slot });
        // 中断された合成はキャッシュに書かない
        if (jobSignal.aborted) throw jobSignal.reason;
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
    }, `${engine.id}/${voice.id}`, { signal, waitTimeoutMs: this.d.timeoutSec * 1000 });
    const r = await promise;
    return {
      audio: r.audio, contentType, engine, voice: voice.id, durationMs: r.durationMs, sampleRate: r.sampleRate,
      synthesisMs: r.synthesisMs, cache: useCache ? 'miss' : 'bypass', key,
    };
  }
}
