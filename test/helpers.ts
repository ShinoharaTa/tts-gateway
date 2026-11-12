/**
 * テストの共通部品: 偽のエンジン、一時ディレクトリ。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invalid } from '../src/errors.ts';
import type { Engine, EngineStatus, VoiceInfo } from '../src/engines/types.ts';
import type { ModelRecord, Registry } from '../src/models/registry.ts';
import type { Settings } from '../src/settings.ts';
import { checkKeys, checkNumber, checkObject } from '../src/validate.ts';

export const tempDir = async (): Promise<{ dir: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-gateway-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

/**
 * 偽のエンジン。1 文につき「前 pad 個の無音 + 文字数 × perChar 個の 0.5 + 後 pad 個の無音」を返す。
 * calls に合成した文、signals に渡された signal を記録する。delayMs で合成に時間をかけられる
 */
export class FakeEngine implements Engine {
  id: string;
  name = 'Fake';
  version = '0.0.1';
  sampleRate = 8000;
  credit = { ja: '音声合成：偽', en: 'Speech synthesis: Fake (https://example.com)', url: 'https://example.com' };
  modelExt = '.fake';
  optionsKey: string;
  calls: { sentence: string; voice: string; opts: Record<string, unknown> }[] = [];
  signals: AbortSignal[] = [];
  delayMs = 0;
  pad = 80;
  perChar = 10;
  verifyResult: Error | null = null;
  registry: Registry | null = null;
  settings: (() => Settings) | null = null;

  constructor(id = 'zen-tts', optionsKey = 'zenTts') {
    this.id = id;
    this.optionsKey = optionsKey;
  }

  describe(): Record<string, unknown> {
    return { options: ['speed'] };
  }

  voices(): VoiceInfo[] {
    const def = this.settings?.().defaultVoices[this.id];
    return (this.registry?.list(this.id) ?? []).map(m => ({ id: m.id, name: m.name, installed: m.status === 'installed', default: m.id === def }));
  }

  validateOptions(raw: unknown): Record<string, unknown> {
    if (raw === undefined) return {};
    const o = checkObject(raw, this.optionsKey);
    checkKeys(o, ['speed'], `${this.optionsKey}.`);
    if (o.speed === undefined) return {};
    if (typeof o.speed !== 'number') throw invalid('speed must be a number', `${this.optionsKey}.speed`);
    return { speed: checkNumber(o.speed, `${this.optionsKey}.speed`, 0.5, 1.5) };
  }

  async verifyModel(_path: string): Promise<{ voiceId: string }> {
    if (this.verifyResult) throw this.verifyResult;
    return { voiceId: 'fake' };
  }

  async synthesize(sentence: string, voice: ModelRecord, opts: Record<string, unknown>, signal: AbortSignal): Promise<Float32Array> {
    this.calls.push({ sentence, voice: voice.id, opts });
    this.signals.push(signal);
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(signal.reason);
        });
      });
    }
    const n = [...sentence].length * this.perChar;
    const pcm = new Float32Array(this.pad + n + this.pad);
    pcm.fill(0.5, this.pad, this.pad + n);
    return pcm;
  }

  status(): EngineStatus {
    return { id: this.id, loaded: null, kernel: null, process: null, idleUnloadSec: this.settings?.().idleUnloadSec ?? 0 };
  }

  async close(): Promise<void> {}
}

export const installedModel = (engine: string, id: string): ModelRecord => ({
  engine,
  id,
  name: id,
  source: { url: `https://example.com/${id}`, sha256: 'a'.repeat(64) },
  status: 'installed',
  bytes: 1,
  progress: null,
  error: null,
  addedAt: '2026-01-01T00:00:00Z',
});
