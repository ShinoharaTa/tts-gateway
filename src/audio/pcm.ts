/**
 * PCM（モノラル float32、[-1, 1]）の加工: 前後の無音を詰める、無音を作る、音量、連結、16bit WAV の書き出し。
 */

/** 無音詰め。振幅の絶対値がしきい値未満の前後を削り、子音の立ち上がりを切らないよう marginMs だけ残す */
export const TRIM = { threshold: 0.01, marginMs: 20 } as const;

export const msToSamples = (ms: number, sampleRate: number): number => Math.round((ms * sampleRate) / 1000);
export const samplesToMs = (samples: number, sampleRate: number): number => Math.round((samples * 1000) / sampleRate);

/** 前後の無音を詰めた区間（全部が無音なら長さ 0） */
export const trimSilence = (
  pcm: Float32Array,
  sampleRate: number,
  threshold: number = TRIM.threshold,
  marginMs: number = TRIM.marginMs,
): Float32Array => {
  let start = 0;
  while (start < pcm.length && Math.abs(pcm[start]!) < threshold) start++;
  if (start === pcm.length) return pcm.subarray(0, 0);
  let end = pcm.length;
  while (end > start && Math.abs(pcm[end - 1]!) < threshold) end--;
  const margin = msToSamples(marginMs, sampleRate);
  return pcm.subarray(Math.max(0, start - margin), Math.min(pcm.length, end + margin));
};

export const silence = (ms: number, sampleRate: number): Float32Array => new Float32Array(msToSamples(ms, sampleRate));

/** 順に並べる */
export const concat = (parts: readonly Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** 音量を dB で増減する（その場で書き換える）。クリップしないよう ±1 に丸める */
export const applyGain = (pcm: Float32Array, db: number): Float32Array => {
  if (db === 0) return pcm;
  const g = 10 ** (db / 20);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-1, Math.min(1, pcm[i]! * g));
  return pcm;
};

/** float32 [-1, 1] → 16bit リトルエンディアン */
export const toS16 = (pcm: Float32Array): Buffer => {
  const out = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i]!)) * 0x7fff), i * 2);
  return out;
};

/** 16bit PCM モノラルの WAV（44 バイトのヘッダ + データ） */
export const wavBuffer = (pcm: Float32Array, sampleRate: number): Buffer => {
  const data = toS16(pcm);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // fmt チャンクの長さ
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // モノラル
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); // バイト/秒
  h.writeUInt16LE(2, 32); // ブロックの大きさ
  h.writeUInt16LE(16, 34); // ビット数
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};
