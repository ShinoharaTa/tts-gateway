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

/** 変更前の splitSentences（長い文を切るたびに文字列を作り直す。O(n²)） */
const legacySplitSentences = (text: string, maxChars: number): string[] => {
  const SENTENCE_END_RE = /[。！？!?]/;
  const SOFT_BREAK_RE = /[、，, 　]/;
  const SPEAKABLE_RE = /[\p{L}\p{N}]/u;
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
      if (SENTENCE_END_RE.test(chars[i]!) && !SENTENCE_END_RE.test(chars[i + 1] ?? '')) {
        push(chars.slice(start, i + 1).join(''));
        start = i + 1;
      }
    }
    push(chars.slice(start).join(''));
  }
  return out;
};

test('splitSentences: 変更前の実装と同じ分け方', () => {
  const inputs = [
    '一つ目。二つ目!三つ目?\n四つ目',
    '本当?!そうです。。。\r\n\n  \nはい。」',
    'あ'.repeat(500),
    `${'あいう、'.repeat(80)}えお。${'word '.repeat(70)}`,
    `${'長い文 '.repeat(40)}　${'か　'.repeat(50)} 。 ！？ 😀${'𠮷'.repeat(130)}、\t終わり。`,
    '  前後に空白  。　　次、  ,  ,  ， の文  \n\t',
  ];
  let seed = 3;
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x80000000);
  const pieces = ['あ', 'a', ' ', '、', ',', '，', '　', '。', '!', '?', '！', '？', '\n', '\r\n', '\t', '😀', '・', '「', '」'];
  for (let n = 0; n < 200; n++) {
    let s = '';
    const len = Math.floor(rand() * 400);
    for (let i = 0; i < len; i++) s += pieces[Math.floor(rand() * pieces.length)];
    inputs.push(s);
  }
  // 120 は既定、96 は zenTts.speed 0.8 の sentenceCharLimit、20 は maxSentenceChars の下限
  for (const input of inputs) {
    for (const max of [120, 96, 20, Infinity]) assert.deepEqual(splitSentences(input, max), legacySplitSentences(input, max), JSON.stringify({ input, max }));
  }
});

test('splitSentences: 10 万字でも 500ms 以内（句読点なし・あり）', () => {
  for (const text of ['あ'.repeat(100_000), 'あいうえお、かきくけこ。'.repeat(100_000 / 12), 'word '.repeat(20_000)]) {
    const started = performance.now();
    const out = splitSentences(text, 120);
    const ms = performance.now() - started;
    assert.ok(out.length > 0);
    assert.ok(ms < 500, `${ms.toFixed(0)}ms`);
  }
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

const setup = async (o: { concurrency?: number; timeoutSec?: number } = {}) => {
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
  const queue = new SynthQueue({ concurrency: o.concurrency ?? 1, max: 8 });
  const synth = new Synthesizer({
    engines: new Map([[engine.id, engine]]), registry, settings, cache, queue,
    dictionary, maxChars: 2000, timeoutSec: o.timeoutSec ?? 60, ffmpeg: 'false',
  });
  return { synth, engine, settings, registry, cache, queue, cleanup };
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

test('Synthesizer: normalize と synthesize は 前処理の前段 → 辞書 → 後段 の順', async () => {
  const { synth, engine, cleanup } = await setup();
  try {
    const readings = { 'GPT-4o': 'ジーピーティーフォーオー', 'COVID-19': 'コビッドナインティーン', NASA: 'ナサ' };
    const text = 'GPT-4o と COVID-19 と NASA と Pixel-9 は 25%。\nhttps://example.com/a！すごい？';
    const spoken = 'ジーピーティーフォーオー と コビッドナインティーン と ナサ と ピクセル 9 は 25パーセント。\n!すごい?';
    const n = synth.normalize({ text, readings });
    assert.equal(n.spoken, spoken);
    assert.deepEqual(n.unknownWords, []);
    await synth.synthesize({ text, readings, cache: false });
    assert.deepEqual(engine.calls.map(c => c.sentence), n.sentences);
    assert.equal(n.sentences[0], spoken.split('\n')[0]);
    // 登録の無い 4 字以上の大文字語は未知語。3 字以内は出ない
    assert.deepEqual(synth.normalize({ text: 'NASA の API' }).unknownWords, [{ word: 'NASA', count: 1 }]);
  } finally {
    await cleanup();
  }
});

test('Synthesizer: 2 スロットで声 A/B が交互に来ても、スロットごとに同じ声を流して読み直さない', async () => {
  const { synth, engine, registry, cleanup } = await setup({ concurrency: 2 });
  try {
    await registry.add(installedModel('zen-tts', 'kai'));
    engine.delayMs = 20;
    // A は 2 文・B は 1 文（B が先に終わる）。FIFO なら空いたスロットに次の A が入って読み直しが起きる
    const reqs = [0, 1, 2, 3, 4, 5, 6, 7].map(i =>
      i % 2 === 0
        ? synth.synthesize({ text: `いち${i}。に${i}。`, voice: 'marine', cache: false })
        : synth.synthesize({ text: `さん${i}。`, voice: 'kai', cache: false }),
    );
    await Promise.all(reqs);
    assert.equal(engine.calls.length, 4 * 2 + 4);
    // スロットごとの声の並び（同じ声が続けば 1 つにまとめる）
    const runs = (slot: number) =>
      engine.calls.filter(c => c.slot === slot).map(c => c.voice).filter((v, i, a) => v !== a[i - 1]);
    // 両方の声が待っている間はスロットが声を保つ。B が尽きた後は空いたスロット 1 が残りの A を取る（規則 4）
    assert.deepEqual(runs(0), ['marine']);
    assert.deepEqual(runs(1), ['kai', 'marine']);
    // FIFO なら B が先に空けたスロットへ次の A、A が空けたスロットへ次の B が入り、ほぼ毎回読み直す
    assert.equal(engine.loads, 3);
  } finally {
    await cleanup();
  }
});

test('Synthesizer.normalize: 文分割にエンジンの sentenceCharLimit を使う（zenTts.speed を受ける）', async () => {
  const { synth, engine, cleanup } = await setup();
  try {
    const limit = (opts: Record<string, unknown>): number => Math.floor(120 * Math.min(1, (opts.speed as number | undefined) ?? 1));
    Object.assign(engine, { sentenceCharLimit: limit });
    const text = 'か'.repeat(100);
    assert.deepEqual(synth.normalize({ text }).sentences, [text]);
    assert.deepEqual(synth.normalize({ text, zenTts: { speed: 0.5 } }).sentences, ['か'.repeat(60), 'か'.repeat(40)]);
    // maxSentenceChars の方が小さければそちら
    assert.deepEqual(synth.normalize({ text, maxSentenceChars: 50, zenTts: { speed: 0.5 } }).sentences, ['か'.repeat(50), 'か'.repeat(50)]);
    assert.throws(() => synth.normalize({ text, zenTts: { speed: 0.4 } }), /speed/);
  } finally {
    await cleanup();
  }
});

test('Synthesizer: 待ち行列で timeoutSec を超えて待った要求は 503（Retry-After 付き）、行列に残らない', async () => {
  const { synth, engine, queue, cleanup } = await setup({ timeoutSec: 0.2 });
  try {
    let open!: () => void;
    const busy = queue.run(undefined, () => new Promise<void>(r => (open = r)));
    await assert.rejects(synth.synthesize({ text: 'こんにちは。' }), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 503);
      assert.equal(e.retryAfterSec, 5);
      return true;
    });
    assert.equal(queue.stats().waiting, 0);
    open();
    await busy.promise;
    assert.equal(engine.calls.length, 0);
  } finally {
    await cleanup();
  }
});

test('Synthesizer: signal の abort はエンジンに届き、中断した合成はキャッシュに書かない', async () => {
  const { synth, engine, cleanup } = await setup();
  try {
    engine.delayMs = 200;
    const ac = new AbortController();
    const p = synth.synthesize({ text: 'こんにちは。' }, ac.signal);
    await new Promise(r => setTimeout(r, 50));
    ac.abort(new Error('client disconnected'));
    await assert.rejects(p, /client disconnected/);
    assert.equal(engine.signals.length, 1);
    assert.equal(engine.signals[0]!.aborted, true);
    // 中断の後でもキャッシュには無い
    engine.delayMs = 0;
    assert.equal((await synth.synthesize({ text: 'こんにちは。' })).cache, 'miss');
  } finally {
    await cleanup();
  }
});
