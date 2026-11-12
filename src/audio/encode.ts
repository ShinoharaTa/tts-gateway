/**
 * PCM → 各形式。wav でサンプルレートがそのままなら ffmpeg を使わない。
 * ほかは ffmpeg に s16le を流し込み、一時ファイルに書かせて読む（m4a の faststart は出力のシークが要るため、パイプにしない）。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../errors.ts';
import { toS16, wavBuffer } from './pcm.ts';

export const FORMATS = ['wav', 'mp3', 'opus', 'm4a', 'flac'] as const;
export type Format = (typeof FORMATS)[number];

export const SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const;

export const CONTENT_TYPES: Record<Format, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
};

export const EXTENSIONS: Record<Format, string> = { wav: 'wav', mp3: 'mp3', opus: 'ogg', m4a: 'm4a', flac: 'flac' };

/** 圧縮形式の既定のビットレート */
export const DEFAULT_BITRATES: Partial<Record<Format, string>> = { mp3: '128k', opus: '48k', m4a: '64k' };

/** Opus が扱えるサンプルレート。ほかの値（44100・22050）は 48000 で書く */
const OPUS_RATES = new Set([8000, 12000, 16000, 24000, 48000]);

/** その形式で実際に書くサンプルレート */
export const outputSampleRate = (format: Format, sampleRate: number): number =>
  format === 'opus' && !OPUS_RATES.has(sampleRate) ? 48000 : sampleRate;

/** ffmpeg 1 回の上限（ms）。超えたら kill して 503 */
export const FFMPEG_TIMEOUT_MS = 30_000;

export type EncodeOptions = {
  format: Format;
  sampleRate: number;
  bitrate?: string;
  ffmpeg: string;
  /** abort されたら ffmpeg を kill し、signal.reason で失敗する */
  signal?: AbortSignal;
  /** ffmpeg の上限（既定 FFMPEG_TIMEOUT_MS。テスト用） */
  timeoutMs?: number;
};

const CODEC_ARGS: Record<Format, (bitrate?: string) => string[]> = {
  wav: () => ['-c:a', 'pcm_s16le', '-f', 'wav'],
  mp3: b => ['-c:a', 'libmp3lame', '-b:a', b ?? DEFAULT_BITRATES.mp3!, '-f', 'mp3'],
  opus: b => ['-c:a', 'libopus', '-b:a', b ?? DEFAULT_BITRATES.opus!, '-f', 'ogg'],
  m4a: b => ['-c:a', 'aac', '-b:a', b ?? DEFAULT_BITRATES.m4a!, '-movflags', '+faststart', '-f', 'mp4'],
  flac: () => ['-c:a', 'flac', '-f', 'flac'],
};

/** その形式・サンプルレートにするのに ffmpeg が要るか */
export const needsFfmpeg = (format: Format, sampleRate: number, inputRate: number): boolean =>
  !(format === 'wav' && outputSampleRate(format, sampleRate) === inputRate);

/** ffmpeg が起動できないときの 503 */
export const ffmpegUnavailable = (ffmpeg: string): ApiError =>
  new ApiError(503, 'engine_unavailable', `ffmpeg is not available (${ffmpeg})`);

export type FfmpegStatus = { available: boolean; path: string; version: string | null; reason: string | null };

/** spawn が起動できなかったことを表すエラーコード（同期 throw・'error' イベントのどちらでも来る） */
const START_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES']);

/** sh が「コマンドが見つからない」で返す終了コード */
const NOT_FOUND_EXIT = 127;

/** `ffmpeg -version` が 0 で終われば使える。版は 1 行目の "ffmpeg version X" の X。使えないときは reason に理由 */
export const probeFfmpeg = (ffmpeg: string, timeoutMs = 5000): Promise<FfmpegStatus> =>
  new Promise(resolve => {
    let stdout = '';
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (reason: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const first = stdout.split('\n', 1)[0] ?? '';
      const version = reason === null ? (/^ffmpeg version (\S+)/.exec(first)?.[1] ?? null) : null;
      resolve({ available: reason === null, path: ffmpeg, version, reason });
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpeg, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      // ENOTDIR などは spawn が同期的に throw する
      finish((e as Error).message);
      return;
    }
    timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(`timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    proc.stdout!.on('data', (d: Buffer) => {
      if (stdout.length < 4000) stdout += d.toString();
    });
    proc.on('error', e => finish(e.message));
    proc.on('close', (code, signal) => finish(code === 0 ? null : `exited ${code ?? signal}`));
  });

/**
 * ffmpeg の有無を覚えておく。get() は前回の probe から intervalMs（既定 30 秒）たっていれば probe し直し、
 * それまでは前回の結果を返す。probe 中に呼ばれたら同じ probe の結果を待つ（同時に 1 本だけ）
 */
export class FfmpegProbe {
  readonly path: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly timeoutMs: number | undefined;
  private last: FfmpegStatus | null = null;
  private lastAt = 0;
  private running: Promise<FfmpegStatus> | null = null;

  constructor(path: string, o: { intervalMs?: number; now?: () => number; timeoutMs?: number } = {}) {
    this.path = path;
    this.intervalMs = o.intervalMs ?? 30_000;
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs;
  }

  get(): Promise<FfmpegStatus> {
    if (this.running) return this.running;
    if (this.last && this.now() - this.lastAt < this.intervalMs) return Promise.resolve(this.last);
    this.running = probeFfmpeg(this.path, this.timeoutMs).then(s => {
      this.last = s;
      this.lastAt = this.now();
      this.running = null;
      return s;
    });
    return this.running;
  }
}

/** pcm（inputRate のモノラル）を o.format にする */
export const encode = async (pcm: Float32Array, inputRate: number, o: EncodeOptions): Promise<Buffer> => {
  const rate = outputSampleRate(o.format, o.sampleRate);
  if (!needsFfmpeg(o.format, o.sampleRate, inputRate)) return wavBuffer(pcm, inputRate);
  if (o.signal?.aborted) throw o.signal.reason;
  const dir = await mkdtemp(join(tmpdir(), 'tts-gateway-enc-'));
  const out = join(dir, `out.${EXTENSIONS[o.format]}`);
  try {
    await runFfmpeg(o.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 's16le', '-ar', String(inputRate), '-ac', '1', '-i', 'pipe:0',
      '-ar', String(rate), '-ac', '1', ...CODEC_ARGS[o.format](o.bitrate), out,
    ], toS16(pcm), o.signal, o.timeoutMs ?? FFMPEG_TIMEOUT_MS);
    return await readFile(out);
  } finally {
    // 成功・失敗・abort・タイムアウトのどれでも消す（kill した場合も終了を待ってから来る）
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * ffmpeg を 1 回動かす。abort・タイムアウトでは SIGKILL し、終了（'exit'）を待ってから失敗する。
 * 'close' は孫プロセスが stdio を握っていると来ないことがあるので、kill した後は待たない
 */
const runFfmpeg = (ffmpeg: string, args: string[], input: Buffer, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch {
      // ENOTDIR などは spawn が同期的に throw する
      reject(ffmpegUnavailable(ffmpeg));
      return;
    }
    let settled = false;
    /** kill した理由。決まったら 'exit' でこれを返す */
    let killedWith: unknown;
    const settle = (e?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (e === undefined) resolve();
      else reject(e);
    };
    const kill = (reason: unknown): void => {
      if (settled || killedWith !== undefined) return;
      killedWith = reason;
      proc.stderr!.destroy();
      proc.kill('SIGKILL');
      // 既に終わっていれば 'exit' は来ない
      if (proc.exitCode !== null || proc.signalCode !== null) settle(reason);
    };
    const onAbort = (): void => kill(signal!.reason);
    const timer = setTimeout(
      () => kill(new ApiError(503, 'engine_unavailable', `ffmpeg (${ffmpeg}) timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });

    let stderr = '';
    proc.stderr!.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    proc.stderr!.on('error', () => {});
    // 常設（settle 後に来ても未処理の 'error' にしない）
    proc.on('error', (e: NodeJS.ErrnoException) =>
      settle(
        killedWith ??
          (START_ERRORS.has(e.code ?? '')
            ? ffmpegUnavailable(ffmpeg)
            : new Error(`ffmpeg (${ffmpeg}) failed to start: ${e.message}`)),
      ),
    );
    proc.on('exit', () => {
      if (killedWith !== undefined) settle(killedWith);
    });
    proc.on('close', code =>
      settle(
        killedWith ??
          (code === 0
            ? undefined
            : code === NOT_FOUND_EXIT
              ? ffmpegUnavailable(ffmpeg)
              : new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)),
      ),
    );
    proc.stdin!.on('error', () => {});
    proc.stdin!.end(input);
    if (signal?.aborted) onAbort();
  });
