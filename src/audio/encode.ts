/**
 * PCM → 各形式。wav でサンプルレートがそのままなら ffmpeg を使わない。
 * ほかは ffmpeg に s16le を流し込み、一時ファイルに書かせて読む（m4a の faststart は出力のシークが要るため、パイプにしない）。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

export type EncodeOptions = { format: Format; sampleRate: number; bitrate?: string; ffmpeg: string };

const CODEC_ARGS: Record<Format, (bitrate?: string) => string[]> = {
  wav: () => ['-c:a', 'pcm_s16le', '-f', 'wav'],
  mp3: b => ['-c:a', 'libmp3lame', '-b:a', b ?? DEFAULT_BITRATES.mp3!, '-f', 'mp3'],
  opus: b => ['-c:a', 'libopus', '-b:a', b ?? DEFAULT_BITRATES.opus!, '-f', 'ogg'],
  m4a: b => ['-c:a', 'aac', '-b:a', b ?? DEFAULT_BITRATES.m4a!, '-movflags', '+faststart', '-f', 'mp4'],
  flac: () => ['-c:a', 'flac', '-f', 'flac'],
};

/** pcm（inputRate のモノラル）を o.format にする */
export const encode = async (pcm: Float32Array, inputRate: number, o: EncodeOptions): Promise<Buffer> => {
  const rate = outputSampleRate(o.format, o.sampleRate);
  if (o.format === 'wav' && rate === inputRate) return wavBuffer(pcm, inputRate);
  const dir = await mkdtemp(join(tmpdir(), 'tts-gateway-enc-'));
  const out = join(dir, `out.${EXTENSIONS[o.format]}`);
  try {
    await runFfmpeg(o.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 's16le', '-ar', String(inputRate), '-ac', '1', '-i', 'pipe:0',
      '-ar', String(rate), '-ac', '1', ...CODEC_ARGS[o.format](o.bitrate), out,
    ], toS16(pcm));
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runFfmpeg = (ffmpeg: string, args: string[], input: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    proc.on('error', e => reject(new Error(`ffmpeg (${ffmpeg}) failed to start: ${e.message}`)));
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
