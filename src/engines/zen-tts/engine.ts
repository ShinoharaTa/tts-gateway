/**
 * ZEN-TTS エンジン（docs/design.md「ZEN-TTS エンジン」）。合成は child.ts を child_process.fork した子プロセスで行う
 * （worker_threads では解放しても RSS が戻らないため）。
 *
 * - 子プロセスは poolSize（TTS_CONCURRENCY）個まで。待ち行列のスロット 1 つに子 1 つで、子ごとに 1 つの声を読む
 *   （どのスロットにどの要求を流すかは queue.ts が決める）
 * - そのスロットの子と別の声の文が来たら、その子を終了してその声で起動し直す（待ちは FIFO）
 * - スロットごとに、idleUnloadSec 使われなければその子を終了してメモリを返す（0 は解放しない）
 * - 子が落ちたら合成中の文は 503。次の文で起動し直す。1 文 30 秒を超えたら子を終了して 504
 * - 1 回の合成の上限（字数・音素数・フレーム数）を超えた文は SentenceTooLongError（子はそのまま使う。分割は synthesize.ts）
 * - 子の error イベントは fork 直後から終了まで常に受ける（fork の失敗も 503。プロセスを落とさない）
 * - このファイルは zen-tts を読み込まない（読み込むのは子だけ。親のメモリを増やさない）
 */
import { fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ApiError, invalid } from '../../errors.ts';
import type { ModelRecord, Registry } from '../../models/registry.ts';
import type { Settings } from '../../settings.ts';
import { checkBool, checkEnum, checkInt, checkKeys, checkNumber, checkObject, checkString } from '../../validate.ts';
import { SentenceTooLongError, type Engine, type EngineStatus, type VoiceInfo } from '../types.ts';

export const ENGINE_ID = 'zen-tts';

/** node_modules/zen-tts/package.json の version（読めなければ 'unknown'）。zen-tts 本体は読み込まない */
const readZenTtsVersion = (): string => {
  try {
    const path = createRequire(import.meta.url).resolve('zen-tts/package.json');
    const v = (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v ? v : 'unknown';
  } catch {
    return 'unknown';
  }
};
export const ZEN_TTS_VERSION = readZenTtsVersion();
export const SAMPLE_RATE = 44100;
export const CREDIT = {
  ja: '音声合成：ZEN-TTS（https://zenryokukikai.com）',
  en: 'Speech synthesis: ZEN-TTS (https://zenryokukikai.com)',
  url: 'https://zenryokukikai.com',
};

export const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'apologetic'] as const;
export const CURVES = ['ease', 'linear', 'fast-start', 'late-surge', 'switch', 'steps', 'hill', 'valley', 'wave'] as const;
export const OPTIONS = ['emotion', 'change', 'strength', 'speed', 'pitch', 'latin', 'numbers', 'accentDict', 'accentSettings'] as const;
export const NUMBER_READINGS = ['rule', 'model'] as const;
export const MAX_ACCENT_DICT = 100;

type Emotion = (typeof EMOTIONS)[number];
type EmotionAmounts = Partial<Record<Emotion, number>>;

export type AccentDictEntry = {
  surface: string;
  reading: string;
  accent?: number;
  phrase?: 'split' | 'join';
  strength?: number;
  contour?: number[];
  pitch?: number[];
  length?: number[];
  note?: string;
};

export type ZenTtsOptions = {
  emotion?: EmotionAmounts;
  change?: { to: EmotionAmounts; curve?: (typeof CURVES)[number]; from?: number; until?: number };
  strength?: number;
  speed?: number;
  pitch?: number;
  latin?: boolean;
  numbers?: (typeof NUMBER_READINGS)[number];
  accentDict?: AccentDictEntry[];
  accentSettings?: { accentHeight: number; pitchRange?: number[] };
};

const P = 'zenTts.';

const checkEmotion = (v: unknown, field: string): EmotionAmounts => {
  const o = checkObject(v, field);
  checkKeys(o, EMOTIONS, `${field}.`);
  const out: EmotionAmounts = {};
  for (const name of EMOTIONS) {
    if (o[name] !== undefined) out[name] = checkNumber(o[name], `${field}.${name}`, 0, Number.MAX_VALUE);
  }
  return out;
};

const checkNumbers = (v: unknown, field: string, min: number, max: number): number[] => {
  if (!Array.isArray(v)) throw invalid(`${field} must be an array of numbers`, field);
  return v.map((x, i) => checkNumber(x, `${field}[${i}]`, min, max));
};

const DICT_KEYS = ['surface', 'reading', 'accent', 'phrase', 'strength', 'contour', 'pitch', 'length', 'note'] as const;
const KANA_RE = /^[\p{Script=Katakana}\p{Script=Hiragana}ー]+$/u;

const checkDictEntry = (v: unknown, field: string): AccentDictEntry => {
  const o = checkObject(v, field);
  checkKeys(o, DICT_KEYS, `${field}.`);
  if (o.surface === undefined) throw invalid(`${field}.surface is required`, `${field}.surface`);
  if (o.reading === undefined) throw invalid(`${field}.reading is required`, `${field}.reading`);
  const surface = checkString(o.surface, `${field}.surface`);
  if (!surface) throw invalid(`${field}.surface must not be empty`, `${field}.surface`);
  const reading = checkString(o.reading, `${field}.reading`);
  if (!KANA_RE.test(reading)) throw invalid(`${field}.reading must be katakana or hiragana`, `${field}.reading`);
  const out: AccentDictEntry = { surface, reading };
  if (o.accent !== undefined) out.accent = checkInt(o.accent, `${field}.accent`, 0, 100);
  if (o.phrase !== undefined) out.phrase = checkEnum(o.phrase, `${field}.phrase`, ['split', 'join'] as const);
  if (o.strength !== undefined) out.strength = checkNumber(o.strength, `${field}.strength`, 0, 2);
  if (o.contour !== undefined) out.contour = checkNumbers(o.contour, `${field}.contour`, -3, 3);
  if (o.pitch !== undefined) out.pitch = checkNumbers(o.pitch, `${field}.pitch`, -24, 24);
  if (o.length !== undefined) out.length = checkNumbers(o.length, `${field}.length`, 0.1, 10);
  if (o.note !== undefined) out.note = checkString(o.note, `${field}.note`);
  return out;
};

/** zenTts オブジェクトの検査（docs/api.md の zenTts の表）。未指定の項目は入れない（ZEN-TTS の既定に任せる） */
export const validateZenTtsOptions = (raw: unknown): ZenTtsOptions => {
  if (raw === undefined) return {};
  const o = checkObject(raw, 'zenTts');
  checkKeys(o, OPTIONS, P);
  const out: ZenTtsOptions = {};
  if (o.emotion !== undefined) out.emotion = checkEmotion(o.emotion, `${P}emotion`);
  if (o.change !== undefined) {
    const f = `${P}change`;
    const c = checkObject(o.change, f);
    checkKeys(c, ['to', 'curve', 'from', 'until'], `${f}.`);
    if (c.to === undefined) throw invalid(`${f}.to is required`, `${f}.to`);
    const change: NonNullable<ZenTtsOptions['change']> = { to: checkEmotion(c.to, `${f}.to`) };
    if (c.curve !== undefined) change.curve = checkEnum(c.curve, `${f}.curve`, CURVES);
    if (c.from !== undefined) change.from = checkNumber(c.from, `${f}.from`, 0, 1);
    if (c.until !== undefined) change.until = checkNumber(c.until, `${f}.until`, 0, 1);
    // ZEN-TTS の既定は from 0・until 1
    if ((change.from ?? 0) >= (change.until ?? 1)) throw invalid(`${f}.from must be less than ${f}.until`, `${f}.from`);
    out.change = change;
  }
  if (o.strength !== undefined) out.strength = checkNumber(o.strength, `${P}strength`, 0, 2);
  if (o.speed !== undefined) out.speed = checkNumber(o.speed, `${P}speed`, 0.5, 1.5);
  if (o.pitch !== undefined) out.pitch = checkNumber(o.pitch, `${P}pitch`, -6, 12);
  if (o.latin !== undefined) out.latin = checkBool(o.latin, `${P}latin`);
  if (o.numbers !== undefined) out.numbers = checkEnum(o.numbers, `${P}numbers`, NUMBER_READINGS);
  if (o.accentDict !== undefined) {
    const f = `${P}accentDict`;
    if (!Array.isArray(o.accentDict)) throw invalid(`${f} must be an array`, f);
    if (o.accentDict.length > MAX_ACCENT_DICT) throw invalid(`${f} must have at most ${MAX_ACCENT_DICT} entries`, f);
    out.accentDict = o.accentDict.map((e, i) => checkDictEntry(e, `${f}[${i}]`));
  }
  if (o.accentSettings !== undefined) {
    const f = `${P}accentSettings`;
    const s = checkObject(o.accentSettings, f);
    checkKeys(s, ['accentHeight', 'pitchRange'], `${f}.`);
    if (s.accentHeight === undefined) throw invalid(`${f}.accentHeight is required`, `${f}.accentHeight`);
    const settings: NonNullable<ZenTtsOptions['accentSettings']> = {
      accentHeight: checkNumber(s.accentHeight, `${f}.accentHeight`, -24, 24),
    };
    if (s.pitchRange !== undefined) {
      const r = checkNumbers(s.pitchRange, `${f}.pitchRange`, 0, 48);
      if (r.length !== 5) throw invalid(`${f}.pitchRange must have 5 numbers (one per emotion)`, `${f}.pitchRange`);
      settings.pitchRange = r;
    }
    out.accentSettings = settings;
  }
  return out;
};

// ---- 子プロセス ----

const CHILD_PATH = fileURLToPath(new URL('./child.ts', import.meta.url));
/** 1 文の合成の上限 */
export const SENTENCE_TIMEOUT_MS = 30_000;
/** 子の起動（重みの読み込み）の上限 */
const LOAD_TIMEOUT_MS = 120_000;

type Child = {
  proc: ChildProcess;
  /** 待ち行列のスロット */
  slot: number;
  voiceId: string;
  state: 'starting' | 'idle' | 'busy';
  kernel: string | null;
  /** 合成中の文 */
  job: { id: number; resolve: (pcm: Float32Array) => void; reject: (e: Error) => void } | null;
  /** stop() で意図的に終了した（exit / error で他の待ちを失敗させない） */
  stopping: boolean;
};

type Waiter = { voice: ModelRecord; slot: number; resolve: (c: Child) => void; reject: (e: Error) => void };

const unavailable = (msg: string): ApiError => new ApiError(503, 'engine_unavailable', msg);
const timeout = (msg: string): ApiError => new ApiError(504, 'timeout', msg);

/** /proc/<pid>/status の VmRSS（Linux 以外は null） */
const rssOf = (pid: number): number | null => {
  try {
    const m = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
};

export type ZenTtsEngineOptions = {
  registry: Registry;
  settings: () => Settings;
  poolSize: number;
  /** テスト用（既定は child.ts） */
  childPath?: string;
  sentenceTimeoutMs?: number;
};

export class ZenTtsEngine implements Engine {
  readonly id = ENGINE_ID;
  readonly name = 'ZEN-TTS';
  readonly version = ZEN_TTS_VERSION;
  readonly sampleRate = SAMPLE_RATE;
  readonly credit = CREDIT;
  readonly modelExt = '.ztm';
  readonly optionsKey = 'zenTts';

  private readonly registry: Registry;
  private readonly settings: () => Settings;
  private readonly poolSize: number;
  private readonly childPath: string;
  private readonly sentenceTimeoutMs: number;
  private children: Child[] = [];
  private readonly waiters: Waiter[] = [];
  /** スロット → アイドル解放のタイマー */
  private readonly idleTimers = new Map<number, NodeJS.Timeout>();
  private nextId = 0;
  private closed = false;

  constructor(o: ZenTtsEngineOptions) {
    this.registry = o.registry;
    this.settings = o.settings;
    this.poolSize = Math.max(1, o.poolSize);
    this.childPath = o.childPath ?? CHILD_PATH;
    this.sentenceTimeoutMs = o.sentenceTimeoutMs ?? SENTENCE_TIMEOUT_MS;
  }

  describe(): Record<string, unknown> {
    return { options: [...OPTIONS], emotions: [...EMOTIONS], curves: [...CURVES] };
  }

  voices(): VoiceInfo[] {
    const def = this.settings().defaultVoices[this.id];
    return this.registry
      .list(this.id)
      .map(m => ({ id: m.id, name: m.name, installed: m.status === 'installed', default: m.id === def }));
  }

  validateOptions(raw: unknown): ZenTtsOptions {
    return validateZenTtsOptions(raw);
  }

  /** speed < 1 だと同じ字数でも長くなり、1 回の合成の上限（約 23.8 秒）を超える。zen-tts の speakStream と同じく 120 × speed 字に縮める */
  sentenceCharLimit(opts: ZenTtsOptions): number {
    return Math.floor(120 * Math.min(1, opts.speed ?? 1));
  }

  /** 別の子プロセスで読み込んでみる（.ztm のヘッダと重み）。読めたら声の id を返す */
  async verifyModel(path: string): Promise<{ voiceId: string }> {
    const proc = this.forkChild();
    try {
      const ready = await this.waitReady(proc, path);
      return { voiceId: ready.voice };
    } finally {
      proc.kill('SIGKILL');
    }
  }

  async synthesize(sentence: string, voice: ModelRecord, opts: ZenTtsOptions, signal: AbortSignal, slot = 0): Promise<Float32Array> {
    const abortReason = (): Error =>
      signal.reason instanceof ApiError ? signal.reason : timeout('synthesis was aborted');
    if (signal.aborted) throw abortReason();
    const s = Math.min(Math.max(0, slot), this.poolSize - 1);
    let child: Child | undefined;
    // 待ち・読み込み中の中断や失敗でも、そのスロットのアイドル解放を張り直す
    try {
      child = await this.acquire(voice, s, signal, abortReason);
      return await this.speakOn(child, sentence, opts, signal, abortReason);
    } finally {
      if (child?.state === 'busy') child.state = 'idle';
      this.schedule();
      this.armIdle(s);
    }
  }

  status(): EngineStatus {
    // loaded・kernel・process は互換のため 1 プロセス分（読み込み済みの最初の子）
    const live = this.children.find(c => c.state !== 'starting') ?? this.children[0];
    return {
      id: this.id,
      loaded: live && live.state !== 'starting' ? live.voiceId : null,
      kernel: live?.kernel ?? null,
      process: live?.proc.pid ? { pid: live.proc.pid, rssBytes: rssOf(live.proc.pid) } : null,
      processes: this.children
        .filter(c => c.proc.pid)
        .sort((a, b) => a.slot - b.slot)
        .map(c => ({ slot: c.slot, voice: c.voiceId, pid: c.proc.pid!, state: c.state, rssBytes: rssOf(c.proc.pid!) })),
      idleUnloadSec: this.settings().idleUnloadSec,
    };
  }

  /** 設定の idleUnloadSec が変わったとき */
  settingsChanged(): void {
    for (const c of this.children) this.armIdle(c.slot);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    for (const w of this.waiters.splice(0)) w.reject(unavailable('engine is closed'));
    this.killAll();
  }

  // ---- 内部 ----

  /** fork する。同期の失敗は 503。error イベントを常に受けるハンドラを付ける（個々の失敗の扱いは waitReady・spawn） */
  private forkChild(): ChildProcess {
    let proc: ChildProcess;
    try {
      proc = fork(this.childPath, [], {
        serialization: 'advanced',
        // 親の --test などを引き継がない
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    } catch (e) {
      throw unavailable(`failed to start synthesis process: ${(e as Error).message}`);
    }
    proc.on('error', e => console.error(`synthesis process error: ${e.message}`));
    return proc;
  }

  /** load を送り、ready を待つ */
  private waitReady(proc: ChildProcess, modelPath: string): Promise<{ kernel: string; voice: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(unavailable('model load timed out'));
      }, LOAD_TIMEOUT_MS);
      const onMessage = (m: { type: string; kernel?: string; voice?: string; message?: string }): void => {
        if (m.type === 'ready') {
          cleanup();
          resolve({ kernel: m.kernel ?? '', voice: m.voice ?? '' });
        } else if (m.type === 'fatal') {
          cleanup();
          reject(unavailable(`failed to load model: ${m.message}`));
        }
      };
      const onExit = (code: number | null, sig: string | null): void => {
        cleanup();
        reject(unavailable(`synthesis process exited while loading (${sig ?? `code ${code}`})`));
      };
      const onError = (e: Error): void => {
        cleanup();
        reject(unavailable(`synthesis process failed: ${e.message}`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        proc.off('message', onMessage);
        proc.off('exit', onExit);
        proc.off('error', onError);
      };
      proc.on('message', onMessage);
      proc.on('exit', onExit);
      proc.on('error', onError);
      proc.send({ type: 'load', modelPath });
    });
  }

  private acquire(voice: ModelRecord, slot: number, signal: AbortSignal, abortReason: () => Error): Promise<Child> {
    if (this.closed) return Promise.reject(unavailable('engine is closed'));
    this.clearIdle(slot);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(abortReason());
        this.schedule();
      };
      const waiter: Waiter = {
        voice,
        slot,
        resolve: c => {
          signal.removeEventListener('abort', onAbort);
          resolve(c);
        },
        reject: e => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      this.schedule();
    });
  }

  /** 待ちの古い順に、そのスロットの子を割り当てる。声が違えば、合成中の文が終わってからその子を入れ替える */
  private schedule(): void {
    // スロットごとに最も古い待ちだけを見る（スロット内は FIFO）
    const seen = new Set<number>();
    for (const w of [...this.waiters]) {
      if (seen.has(w.slot)) continue;
      seen.add(w.slot);
      let child = this.children.find(c => c.slot === w.slot);
      if (child && child.voiceId !== w.voice.id) {
        if (child.state === 'busy') continue;
        this.stop(child);
        child = undefined;
      }
      if (child) {
        if (child.state !== 'idle') continue;
        this.waiters.splice(this.waiters.indexOf(w), 1);
        child.state = 'busy';
        w.resolve(child);
        continue;
      }
      // 起動中の子があればその ready を待つ（同時に起動するのは 1 つずつ）
      if (!this.children.some(c => c.state === 'starting')) this.spawn(w.voice, w.slot);
    }
  }

  /** この子を待っている要求（同じスロット・同じ声）を失敗させる。他のスロットの待ちには触れない */
  private rejectWaiters(slot: number, voiceId: string, e: Error): void {
    for (const w of this.waiters.filter(x => x.slot === slot && x.voice.id === voiceId)) {
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.reject(e);
    }
  }

  private spawn(voice: ModelRecord, slot: number): void {
    let proc: ChildProcess;
    try {
      proc = this.forkChild();
    } catch (e) {
      this.rejectWaiters(slot, voice.id, e as Error);
      return;
    }
    const child: Child = { proc, slot, voiceId: voice.id, state: 'starting', kernel: null, job: null, stopping: false };
    this.children.push(child);
    const modelPath = this.registry.modelPath(this.id, voice.id, this.modelExt);
    this.waitReady(proc, modelPath).then(
      ready => {
        if (!this.children.includes(child)) return;
        child.kernel = ready.kernel;
        child.state = 'idle';
        proc.on('message', (m: { type: string; id?: number; pcm?: Float32Array; message?: string; kind?: string }) => {
          const job = child.job;
          if (!job || job.id !== m.id) return;
          child.job = null;
          if (m.type === 'result') job.resolve(m.pcm!);
          else if (m.kind === 'sentence_too_long') job.reject(new SentenceTooLongError(m.message ?? 'sentence is too long'));
          else job.reject(unavailable(`synthesis failed: ${m.message}`));
        });
        const onGone = (e: Error): void => {
          // stop() で止めた子・もう管理していない子は、待ちに触れない
          if (child.stopping || !this.children.includes(child)) return;
          this.drop(child);
          child.job?.reject(e);
          child.job = null;
          this.schedule();
        };
        proc.on('exit', (code, sig) => onGone(unavailable(`synthesis process exited (${sig ?? `code ${code}`})`)));
        proc.on('error', e => onGone(unavailable(`synthesis process failed: ${e.message}`)));
        this.schedule();
        // 待っていた要求が中断済みなら誰も使わないので、アイドル解放を張る
        this.armIdle(slot);
      },
      (e: Error) => {
        proc.kill('SIGKILL');
        if (child.stopping || !this.children.includes(child)) return;
        this.drop(child);
        // この子を待っている要求は同じ理由で失敗する
        this.rejectWaiters(slot, voice.id, e);
        this.schedule();
      },
    );
  }

  private speakOn(
    child: Child,
    text: string,
    opts: ZenTtsOptions,
    signal: AbortSignal,
    abortReason: () => Error,
  ): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      // 合成は子の中で同期処理なので、止めるには子を終了するしかない
      const kill = (e: Error): void => {
        finish();
        child.job = null;
        this.drop(child);
        child.proc.kill('SIGKILL');
        reject(e);
      };
      const timer = setTimeout(() => kill(timeout(`a sentence took longer than ${this.sentenceTimeoutMs / 1000}s`)), this.sentenceTimeoutMs);
      const onAbort = (): void => kill(abortReason());
      signal.addEventListener('abort', onAbort, { once: true });
      child.job = {
        id,
        resolve: pcm => {
          finish();
          resolve(pcm);
        },
        reject: e => {
          finish();
          reject(e);
        },
      };
      child.proc.send({ type: 'speak', id, text, opts });
    });
  }

  private drop(child: Child): void {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
  }

  /** 子を 1 つ終了する（合成中の文は 503） */
  private stop(child: Child): void {
    child.stopping = true;
    this.drop(child);
    child.job?.reject(unavailable('synthesis process was stopped'));
    child.job = null;
    child.proc.kill('SIGKILL');
  }

  private killAll(): void {
    for (const c of [...this.children]) this.stop(c);
  }

  private clearIdle(slot: number): void {
    const t = this.idleTimers.get(slot);
    if (t) clearTimeout(t);
    this.idleTimers.delete(slot);
  }

  /** そのスロットの子が空いていてそのスロットの待ちが無ければ、idleUnloadSec 後にその子を終了する */
  private armIdle(slot: number): void {
    this.clearIdle(slot);
    const sec = this.settings().idleUnloadSec;
    const idle = (): Child | undefined => {
      const c = this.children.find(x => x.slot === slot);
      return c && c.state === 'idle' && !this.waiters.some(w => w.slot === slot) ? c : undefined;
    };
    if (sec <= 0 || this.closed || !idle()) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(slot);
      const c = idle();
      if (c) this.stop(c);
    }, sec * 1000);
    timer.unref();
    this.idleTimers.set(slot, timer);
  }
}
