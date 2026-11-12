import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { AudioCache } from '../src/cache.ts';
import { cacheKey, type RenderParams } from '../src/synthesize.ts';
import { installedModel, tempDir } from './helpers.ts';

const key = (n: number): string => n.toString(16).padStart(64, '0');
const meta = { contentType: 'audio/wav', durationMs: 100, sampleRate: 8000 };

test('キャッシュキー: 音声に効く値が変われば変わり、同じなら同じ', () => {
  const params: RenderParams = {
    format: 'wav', sampleRate: 44100, bitrate: undefined, volume: 0, sentencePauseMs: 250,
    leadingSilenceMs: 0, trailingSilenceMs: 0, trimSilence: true,
  };
  const base = {
    engine: { id: 'zen-tts', version: '1.3.0' },
    voice: installedModel('zen-tts', 'marine'),
    sentences: ['こんにちは。'],
    params,
    options: { speed: 1, emotion: { happy: 1, neutral: 2 } },
  };
  const k = cacheKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  // オブジェクトのキーの順は効かない
  assert.equal(cacheKey({ ...base, options: { emotion: { neutral: 2, happy: 1 }, speed: 1 } }), k);
  const variants = [
    { ...base, engine: { id: 'zen-tts', version: '1.3.1' } },
    { ...base, voice: { ...base.voice, id: 'kikka' } },
    { ...base, voice: { ...base.voice, source: { url: 'x', sha256: 'b'.repeat(64) } } },
    { ...base, sentences: ['こんにちは!'] },
    { ...base, sentences: ['こんに', 'ちは。'] },
    { ...base, params: { ...params, format: 'mp3' as const, bitrate: '128k' } },
    { ...base, params: { ...params, sampleRate: 24000 } },
    { ...base, params: { ...params, volume: 1 } },
    { ...base, params: { ...params, sentencePauseMs: 0 } },
    { ...base, params: { ...params, trimSilence: false } },
    { ...base, options: { speed: 1.1, emotion: { happy: 1, neutral: 2 } } },
  ];
  const keys = new Set(variants.map(cacheKey));
  assert.equal(keys.size, variants.length);
  assert.ok(!keys.has(k));
});

test('put / get、最終アクセスの古い順に消す（LRU）', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    let now = 1000;
    const c = new AudioCache({ dir, maxBytes: () => 30, ttlMs: () => 1e9, now: () => now });
    await c.init();
    await c.put(key(1), Buffer.alloc(10, 1), meta);
    now++;
    await c.put(key(2), Buffer.alloc(10, 2), meta);
    now++;
    await c.put(key(3), Buffer.alloc(10, 3), meta);
    now++;
    assert.equal(c.stats().entries, 3);
    // 1 を使うと、次に消えるのは 2
    assert.equal((await c.get(key(1)))?.data[0], 1);
    now++;
    await c.put(key(4), Buffer.alloc(10, 4), meta);
    assert.equal(await c.get(key(2)), null);
    assert.ok(await c.get(key(1)));
    assert.ok(await c.get(key(3)));
    assert.ok(await c.get(key(4)));
    assert.equal(c.stats().bytes, 30);
    // 再起動しても LRU の順が続く
    const c2 = new AudioCache({ dir, maxBytes: () => 30, ttlMs: () => 1e9, now: () => now });
    await c2.init();
    assert.equal(c2.stats().entries, 3);
    assert.equal((await c2.get(key(4)))?.meta.durationMs, 100);
    await c2.clear();
    assert.equal(c2.stats().entries, 0);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await cleanup();
  }
});

test('TTL を過ぎたものは消す、maxBytes 0 は無効', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    let now = 0;
    let maxBytes = 1000;
    const c = new AudioCache({ dir, maxBytes: () => maxBytes, ttlMs: () => 100, now: () => now });
    await c.init();
    await c.put(key(1), Buffer.alloc(5), meta);
    now = 50;
    assert.ok(await c.get(key(1)));
    now = 101;
    assert.equal(await c.get(key(1)), null);
    assert.equal(c.stats().entries, 0);
    await c.put(key(2), Buffer.alloc(5), meta);
    now = 300;
    await c.evict();
    assert.equal(c.stats().entries, 0);
    maxBytes = 0;
    assert.equal(c.enabled, false);
    await c.put(key(3), Buffer.alloc(5), meta);
    assert.equal(c.stats().entries, 0);
    assert.equal(await c.get(key(3)), null);
  } finally {
    await cleanup();
  }
});
