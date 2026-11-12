import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/errors.ts';
import { validateZenTtsOptions } from '../src/engines/zen-tts/engine.ts';
import { validateSettingsPatch } from '../src/settings.ts';
import { validateSynthRequest } from '../src/validate.ts';
import { FakeEngine } from './helpers.ts';

const zen = new FakeEngine('zen-tts', 'zenTts');
// zenTts の検査は本物を使う
zen.validateOptions = validateZenTtsOptions;
const other = new FakeEngine('other', 'other');
const ctx = { engines: new Map([[zen.id, zen], [other.id, other]]), defaultEngine: 'zen-tts', maxChars: 20 };

const rejects = (body: unknown, status: number, code: string, field?: string): void => {
  assert.throws(
    () => validateSynthRequest(body, ctx),
    (e: unknown) => {
      assert.ok(e instanceof ApiError, String(e));
      assert.equal(e.status, status, e.message);
      assert.equal(e.code, code);
      if (field !== undefined) assert.equal(e.field, field);
      return true;
    },
  );
};

test('既定値が入る', () => {
  const r = validateSynthRequest({ text: 'こんにちは' }, ctx);
  assert.deepEqual(r, {
    text: 'こんにちは', engine: 'zen-tts', voice: undefined, format: 'wav', sampleRate: undefined, bitrate: undefined,
    volume: 0, sentencePauseMs: 250, leadingSilenceMs: 0, trailingSilenceMs: 0, trimSilence: true, maxSentenceChars: 120,
    preprocess: true, dictionary: true, readings: {}, cache: true, options: {},
  });
});

test('本文が object でない・text が無い・空', () => {
  rejects(null, 400, 'invalid_request');
  rejects([], 400, 'invalid_request');
  rejects({}, 400, 'invalid_request', 'text');
  rejects({ text: '  ' }, 400, 'invalid_request', 'text');
  rejects({ text: 1 }, 400, 'invalid_request', 'text');
});

test('text の上限超えは 413', () => {
  rejects({ text: 'あ'.repeat(21) }, 413, 'text_too_long', 'text');
  // コードポイントで数える
  validateSynthRequest({ text: '😀'.repeat(20) }, ctx);
});

test('未知のフィールドは 400', () => {
  rejects({ text: 'a', speeed: 1 }, 400, 'invalid_request', 'speeed');
  rejects({ text: 'a', zenTts: { speeed: 1 } }, 400, 'invalid_request', 'zenTts.speeed');
  rejects({ text: 'a', zenTts: { emotion: { joy: 1 } } }, 400, 'invalid_request', 'zenTts.emotion.joy');
  rejects({ text: 'a', voicevox: {} }, 400, 'invalid_request', 'voicevox');
});

test('範囲外・型違い', () => {
  rejects({ text: 'a', format: 'ogg' }, 400, 'invalid_request', 'format');
  rejects({ text: 'a', sampleRate: 44101 }, 400, 'invalid_request', 'sampleRate');
  rejects({ text: 'a', volume: 13 }, 400, 'invalid_request', 'volume');
  rejects({ text: 'a', volume: -21 }, 400, 'invalid_request', 'volume');
  rejects({ text: 'a', sentencePauseMs: 3001 }, 400, 'invalid_request', 'sentencePauseMs');
  rejects({ text: 'a', sentencePauseMs: 1.5 }, 400, 'invalid_request', 'sentencePauseMs');
  rejects({ text: 'a', leadingSilenceMs: -1 }, 400, 'invalid_request', 'leadingSilenceMs');
  rejects({ text: 'a', maxSentenceChars: 19 }, 400, 'invalid_request', 'maxSentenceChars');
  rejects({ text: 'a', trimSilence: 'yes' }, 400, 'invalid_request', 'trimSilence');
  rejects({ text: 'a', cache: 0 }, 400, 'invalid_request', 'cache');
  rejects({ text: 'a', zenTts: { speed: 1.6 } }, 400, 'invalid_request', 'zenTts.speed');
  rejects({ text: 'a', zenTts: { speed: 0.4 } }, 400, 'invalid_request', 'zenTts.speed');
  rejects({ text: 'a', zenTts: { pitch: 13 } }, 400, 'invalid_request', 'zenTts.pitch');
  rejects({ text: 'a', zenTts: { pitch: -7 } }, 400, 'invalid_request', 'zenTts.pitch');
  rejects({ text: 'a', zenTts: { strength: 2.1 } }, 400, 'invalid_request', 'zenTts.strength');
  rejects({ text: 'a', zenTts: { numbers: 'auto' } }, 400, 'invalid_request', 'zenTts.numbers');
  rejects({ text: 'a', zenTts: { emotion: { happy: -1 } } }, 400, 'invalid_request', 'zenTts.emotion.happy');
  rejects({ text: 'a', zenTts: { change: { to: { sad: 1 }, from: 0.8, until: 0.2 } } }, 400, 'invalid_request', 'zenTts.change.from');
  rejects({ text: 'a', zenTts: { change: { to: { sad: 1 }, curve: 'zigzag' } } }, 400, 'invalid_request', 'zenTts.change.curve');
  rejects({ text: 'a', zenTts: { change: { curve: 'ease' } } }, 400, 'invalid_request', 'zenTts.change.to');
  rejects({ text: 'a', zenTts: { accentDict: [{ surface: '明日' }] } }, 400, 'invalid_request', 'zenTts.accentDict[0].reading');
  rejects({ text: 'a', zenTts: { accentDict: [{ surface: '明日', reading: 'asu' }] } }, 400, 'invalid_request', 'zenTts.accentDict[0].reading');
  rejects({ text: 'a', zenTts: { accentDict: new Array(101).fill({ surface: 'a', reading: 'ア' }) } }, 400, 'invalid_request', 'zenTts.accentDict');
  rejects({ text: 'a', zenTts: { accentSettings: { pitchRange: [1, 2, 3, 4, 5] } } }, 400, 'invalid_request', 'zenTts.accentSettings.accentHeight');
  rejects({ text: 'a', zenTts: { accentSettings: { accentHeight: 4.5, pitchRange: [1, 2] } } }, 400, 'invalid_request', 'zenTts.accentSettings.pitchRange');
});

test('bitrate: 圧縮形式だけ、形式ごとの範囲（opus 6k〜256k、mp3・m4a 8k〜320k）', () => {
  const bitrate = (format: string, b: string): string | undefined => validateSynthRequest({ text: 'a', format, bitrate: b }, ctx).bitrate;
  assert.equal(bitrate('mp3', '192k'), '192k');
  for (const [format, min, max] of [['opus', 6, 256], ['mp3', 8, 320], ['m4a', 8, 320]] as const) {
    assert.equal(bitrate(format, `${min}k`), `${min}k`);
    assert.equal(bitrate(format, `${max}k`), `${max}k`);
    rejects({ text: 'a', format, bitrate: `${min - 1}k` }, 400, 'invalid_request', 'bitrate');
    rejects({ text: 'a', format, bitrate: `${max + 1}k` }, 400, 'invalid_request', 'bitrate');
  }
  // opus の 257k〜320k は ffmpeg が失敗するので 400
  rejects({ text: 'a', format: 'opus', bitrate: '320k' }, 400, 'invalid_request', 'bitrate');
  rejects({ text: 'a', format: 'mp3', bitrate: '0k' }, 400, 'invalid_request', 'bitrate');
  rejects({ text: 'a', format: 'mp3', bitrate: '064k' }, 400, 'invalid_request', 'bitrate');
  rejects({ text: 'a', bitrate: '128k' }, 400, 'invalid_request', 'bitrate');
  rejects({ text: 'a', format: 'flac', bitrate: '128k' }, 400, 'invalid_request', 'bitrate');
  rejects({ text: 'a', format: 'mp3', bitrate: 128 }, 400, 'invalid_request', 'bitrate');
});

test('readings: 最大 200 語・読みはカタカナ', () => {
  const ok = validateSynthRequest({ text: 'a', readings: { Foo: 'フー ' } }, ctx);
  assert.deepEqual(ok.readings, { Foo: 'フー' });
  rejects({ text: 'a', readings: { Foo: 'ふー' } }, 400, 'invalid_request', 'readings.Foo');
  rejects({ text: 'a', readings: { '': 'フー' } }, 400, 'invalid_request');
  rejects({ text: 'a', readings: [] }, 400, 'invalid_request', 'readings');
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`w${i}`, 'ワ']));
  rejects({ text: 'a', readings: many }, 400, 'invalid_request', 'readings');
});

test('他のエンジンのオプションは 400、未知のエンジンは 404', () => {
  rejects({ text: 'a', other: { speed: 1 } }, 400, 'invalid_request', 'other');
  rejects({ text: 'a', engine: 'other', zenTts: { speed: 1 } }, 400, 'invalid_request', 'zenTts');
  rejects({ text: 'a', engine: 'nope' }, 404, 'not_found', 'engine');
  const r = validateSynthRequest({ text: 'a', engine: 'other', other: { speed: 1.2 } }, ctx);
  assert.deepEqual(r.options, { speed: 1.2 });
});

test('zenTts: 全項目を受ける', () => {
  const o = validateZenTtsOptions({
    emotion: { happy: 70, neutral: 30 },
    change: { to: { sad: 1 }, curve: 'hill', from: 0.2, until: 0.8 },
    strength: 1.5, speed: 1.1, pitch: -3, latin: false, numbers: 'model',
    accentDict: [{ surface: '明日', reading: 'アス', accent: 2, phrase: 'split', strength: 0, contour: [0, 1], pitch: [0, 1], length: [1, 1.2], note: 'x' }],
    accentSettings: { accentHeight: 4.5, pitchRange: [6, 7, 6, 8, 7] },
  });
  assert.equal(o.speed, 1.1);
  assert.equal(o.accentDict?.[0]?.accent, 2);
});

test('settings: 範囲・未知のキー・インストール済みの声', () => {
  const sctx = { engineIds: ['zen-tts'], isInstalled: (_e: string, v: string) => v === 'marine' };
  assert.deepEqual(validateSettingsPatch({ idleUnloadSec: 0, cacheMaxMB: 0, cacheTtlDays: 365 }, sctx), {
    idleUnloadSec: 0, cacheMaxMB: 0, cacheTtlDays: 365,
  });
  assert.deepEqual(validateSettingsPatch({ defaultVoices: { 'zen-tts': 'marine' } }, sctx), { defaultVoices: { 'zen-tts': 'marine' } });
  for (const bad of [{ idleUnloadSec: 59 }, { idleUnloadSec: 86401 }, { cacheMaxMB: 10001 }, { cacheTtlDays: 0 }, { foo: 1 }, { defaultVoices: { 'zen-tts': 'kikka' } }, { defaultVoices: { x: 'marine' } }])
    assert.throws(() => validateSettingsPatch(bad, sctx), (e: unknown) => e instanceof ApiError && e.status === 400, JSON.stringify(bad));
  assert.throws(() => validateSettingsPatch({ defaultEngine: 'x' }, sctx), (e: unknown) => e instanceof ApiError && e.status === 404);
});
