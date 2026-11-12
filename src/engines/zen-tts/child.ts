/**
 * ZEN-TTS の合成プロセス（engine.ts が child_process.fork で起動する）。1 プロセスに 1 つの声を読み込み、文を 1 つずつ合成する。
 *
 * 親 → 子: { type: 'load', modelPath } / { type: 'speak', id, text, opts }
 * 子 → 親: { type: 'ready', kernel, voice, version } / { type: 'fatal', message } /
 *          { type: 'result', id, pcm, sampleRate } / { type: 'error', id, message, kind? }
 * kind: 'sentence_too_long' は 1 回の合成の上限（字数・音素数・フレーム数）を超えた文（子はそのまま次の文を受ける）
 * serialization: 'advanced' なので Float32Array をそのまま送れる。
 */
import { VERSION, ZenTtsNode, type SpeakOptions } from 'zen-tts/node';
import type { ZenTtsOptions } from './engine.ts';

type LoadMsg = { type: 'load'; modelPath: string };
type SpeakMsg = { type: 'speak'; id: number; text: string; opts: ZenTtsOptions };

const send = (m: unknown): void => {
  process.send?.(m);
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** zen-tts の上限超過（`own tts: 300 chars (max 256)`・`… phones (max 512)`・`… frames (max 2048)`） */
const TOO_LONG_RE = /own tts: \d+ (?:chars|phones|frames) \(max \d+\)/;

/** API のオプション名 → speak() のオプション名 */
const speakOptions = (o: ZenTtsOptions): SpeakOptions => ({
  ...(o.emotion ? { emotion: o.emotion } : {}),
  ...(o.change ? { change: o.change } : {}),
  ...(o.strength !== undefined ? { strength: o.strength } : {}),
  ...(o.speed !== undefined ? { speed: o.speed } : {}),
  ...(o.pitch !== undefined ? { pitch: o.pitch } : {}),
  ...(o.latin !== undefined ? { latin: o.latin } : {}),
  ...(o.numbers ? { numbers: o.numbers } : {}),
  ...(o.accentDict?.length ? { dict: o.accentDict } : {}),
  ...(o.accentSettings ? { settings: o.accentSettings } : {}),
});

let tts: ZenTtsNode | null = null;

process.on('message', async (m: LoadMsg | SpeakMsg) => {
  if (m.type === 'load') {
    try {
      // modelsPath を渡さない: G2P はパッケージ同梱の models/g2p を使う
      tts = await ZenTtsNode.load({ model: m.modelPath });
      send({ type: 'ready', kernel: tts.kernel, voice: tts.voice, version: VERSION });
    } catch (e) {
      send({ type: 'fatal', message: message(e) });
    }
  } else if (m.type === 'speak') {
    if (!tts) {
      send({ type: 'error', id: m.id, message: 'model is not loaded' });
      return;
    }
    try {
      const r = await tts.speak(m.text, speakOptions(m.opts));
      send({ type: 'result', id: m.id, pcm: r.pcm, sampleRate: r.sampleRate });
    } catch (e) {
      const msg = message(e);
      send({ type: 'error', id: m.id, message: msg, ...(TOO_LONG_RE.test(msg) ? { kind: 'sentence_too_long' } : {}) });
    }
  }
});

// 親が居なくなったら終わる
process.on('disconnect', () => process.exit(0));
