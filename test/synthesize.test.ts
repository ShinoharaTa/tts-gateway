import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { AudioCache } from '../src/cache.ts';
import { PACKAGE_DIR } from '../src/config.ts';
import { ApiError } from '../src/errors.ts';
import { Registry } from '../src/models/registry.ts';
import { SynthQueue } from '../src/queue.ts';
import { SettingsStore } from '../src/settings.ts';
import { renderAudio, splitSentences, Synthesizer, type RenderParams } from '../src/synthesize.ts';
import { Dictionary } from '../src/text/readings.ts';
import { FakeEngine, installedModel, tempDir } from './helpers.ts';

test('splitSentences: 。！？・改行で分け、記号は前の文に付ける', () => {
  assert.deepEqual(splitSentences('一つ目。二つ目!三つ目?\n四つ目', 120), ['一つ目。', '二つ目!', '三つ目?', '四つ目']);
  assert.deepEqual(splitSentences('本当?!そうです。', 120), ['本当?!', 'そうです。']);
  // 読める文字の無い断片は捨てる
  assert.deepEqual(splitSentences('。。\n\n  \nはい。」', 120), ['はい。']);
});

test('splitSentences: 長い文は上限より前の最後の読点・空白で切り、無ければ上限で切る', () => {
  const s = `${'あ'.repeat(15)}、${'い'.repeat(10)}、${'う'.repeat(10)}`;
  assert.deepEqual(splitSentences(s, 20), [`${'あ'.repeat(15)}、`, `${'い'.repeat(10)}、`, 'う'.repeat(10)]);
  assert.deepEqual(splitSentences('か'.repeat(45), 20), ['か'.repeat(20), 'か'.repeat(20), 'か'.repeat(5)]);
  for (const part of splitSentences('word '.repeat(60), 20)) assert.ok([...part].length <= 20);
});

const PARAMS: RenderParams = {
  format: 'wav', sampleRate: 8000, bitrate: undefined, volume: 0, sentencePauseMs: 250,
  leadingSilenceMs: 100, trailingSilenceMs: 50, trimSilence: true,
};

test('renderAudio: 無音詰め・文間の無音・先頭と末尾の無音・連結・WAV ヘッダ', async () => {
  const engine = new FakeEngine();
  engine.pad = 400;
  const voice = installedModel('zen-tts', 'v');
  const signal = new AbortController().signal;
  const r = await renderAudio({ engine, voice, sentences: ['あい。', 'う。'], params: PARAMS, options: { speed: 1 }, signal, ffmpeg: 'false' });
  // 800（先頭） + (30 + 余白 160×2) + 2000（文間） + (20 + 320) + 400（末尾）
  const samples = 800 + 350 + 2000 + 340 + 400;
  assert.equal(r.audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(r.audio.toString('ascii', 8, 12), 'WAVE');
  assert.equal(r.audio.readUInt16LE(20), 1);
  assert.equal(r.audio.readUInt16LE(22), 1);
  assert.equal(r.audio.readUInt32LE(24), 8000);
  assert.equal(r.audio.readUInt16LE(34), 16);
  assert.equal(r.audio.readUInt32LE(40), samples * 2);
  assert.equal(r.audio.readUInt32LE(4), 36 + samples * 2);
  assert.equal(r.audio.length, 44 + samples * 2);
  assert.equal(r.durationMs, Math.round((samples * 1000) / 8000));
  assert.equal(r.sampleRate, 8000);
  // 先頭は無音、最初の声は 800 + 160 サンプル目から
  assert.equal(r.audio.readInt16LE(44 + 959 * 2), 0);
  assert.equal(r.audio.readInt16LE(44 + 960 * 2), Math.round(0.5 * 0x7fff));
  assert.deepEqual(engine.calls.map(c => c.sentence), ['あい。', 'う。']);
  assert.deepEqual(engine.calls[0]!.opts, { speed: 1 });

  // 詰めない・間 0・音量 +12dB（±1 に丸める）
  const r2 = await renderAudio({
    engine, voice, sentences: ['あい。', 'う。'], options: {}, signal, ffmpeg: 'false',
    params: { ...PARAMS, trimSilence: false, sentencePauseMs: 0, leadingSilenceMs: 0, trailingSilenceMs: 0, volume: 12 },
  });
  assert.equal(r2.audio.readUInt32LE(40), (830 + 820) * 2);
  assert.equal(r2.audio.readInt16LE(44 + 400 * 2), 0x7fff);
});

const setup = async () => {
  const { dir, cleanup } = await tempDir();
  const settings = await SettingsStore.load(join(dir, 'data'));
  const registry = await Registry.load(join(dir, 'data'), () => '.fake');
  await registry.add(installedModel('zen-tts', 'marine'));
  await registry.add({ ...installedModel('zen-tts', 'kikka'), status: 'pending' });
  const engine = new FakeEngine();
  engine.registry = registry;
  const cache = new AudioCache({ dir: join(dir, 'cache'), maxBytes: () => settings.get().cacheMaxMB * 1024 * 1024, ttlMs: () => 1e12 });
  await cache.init();
  const dictionary = await Dictionary.load(join(PACKAGE_DIR, 'dict', 'readings.tsv'), join(dir, 'data', 'readings.tsv'));
  const synth = new Synthesizer({
    engines: new Map([[engine.id, engine]]), registry, settings, cache, queue: new SynthQueue({ concurrency: 1, max: 8 }),
    dictionary, maxChars: 2000, timeoutSec: 60, ffmpeg: 'false',
  });
  return { synth, engine, settings, cleanup };
};

test('Synthesizer: 辞書を通した文を合成し、2 回目はキャッシュ、cache:false は bypass', async () => {
  const { synth, engine, cleanup } = await setup();
  try {
    const body = { text: 'GitHub に push しました。次へ！' };
    const r1 = await synth.synthesize(body);
    assert.equal(r1.cache, 'miss');
    assert.equal(r1.voice, 'marine');
    assert.equal(r1.contentType, 'audio/wav');
    assert.deepEqual(engine.calls.map(c => c.sentence), ['ギットハブ に プッシュ しました。', '次へ!']);
    const r2 = await synth.synthesize(body);
    assert.equal(r2.cache, 'hit');
    assert.equal(r2.synthesisMs, 0);
    assert.equal(r2.key, r1.key);
    assert.deepEqual(r2.audio, r1.audio);
    assert.equal(engine.calls.length, 2);
    const r3 = await synth.synthesize({ ...body, cache: false });
    assert.equal(r3.cache, 'bypass');
    assert.equal(engine.calls.length, 4);
    // 同じ読みになる別の書き方は同じキー
    const r4 = await synth.synthesize({ text: 'GITHUB に Push しました。次へ!' });
    assert.equal(r4.cache, 'hit');
  } finally {
    await cleanup();
  }
});

test('Synthesizer: 同時に来た同じ要求は 1 回だけ合成する', async () => {
  const { synth, engine, cleanup } = await setup();
  try {
    engine.delayMs = 50;
    const [a, b] = await Promise.all([synth.synthesize({ text: 'こんにちは。' }), synth.synthesize({ text: 'こんにちは。' })]);
    assert.equal(engine.calls.length, 1);
    assert.deepEqual(a.audio, b.audio);
  } finally {
    await cleanup();
  }
});

test('Synthesizer: 声の解決（404・422）と、読める文字が無い文', async () => {
  const { synth, settings, cleanup } = await setup();
  try {
    const status = async (body: unknown) => {
      try {
        await synth.synthesize(body);
        return 200;
      } catch (e) {
        return (e as ApiError).status;
      }
    };
    assert.equal(await status({ text: 'あ', voice: 'nope' }), 404);
    assert.equal(await status({ text: 'あ', voice: 'kikka' }), 422);
    assert.equal(await status({ text: '。。。' }), 400);
    await settings.update({ defaultVoices: { 'zen-tts': 'kikka' } });
    assert.equal(await status({ text: 'あ' }), 422);
  } finally {
    await cleanup();
  }
});

test('Synthesizer.normalize: 読み・文・当たった語・未知語', async () => {
  const { synth, cleanup } = await setup();
  try {
    const n = synth.normalize({ text: 'GitHub に Claude のコードを push しました。', format: 'mp3' });
    assert.deepEqual(n, {
      text: 'GitHub に Claude のコードを push しました。',
      spoken: 'ギットハブ に クロード のコードを プッシュ しました。',
      sentences: ['ギットハブ に クロード のコードを プッシュ しました。'],
      hits: [
        { surface: 'github', reading: 'ギットハブ' },
        { surface: 'claude', reading: 'クロード' },
        { surface: 'push', reading: 'プッシュ' },
      ],
      unknownWords: [],
    });
    const m = synth.normalize({ text: 'Foo は 50% です', readings: { Bar: 'バー' }, dictionary: false });
    assert.equal(m.spoken, 'Foo は 50パーセント です');
    assert.deepEqual(m.unknownWords, [{ word: 'Foo', count: 1 }]);
    assert.throws(() => synth.normalize({ text: 'a', format: 'wav', bitrate: '64k' }), /bitrate/);
  } finally {
    await cleanup();
  }
});
