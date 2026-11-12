import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../src/errors.ts';
import { ZenTtsEngine } from '../src/engines/zen-tts/engine.ts';
import type { Registry } from '../src/models/registry.ts';
import { SynthQueue } from '../src/queue.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/settings.ts';
import { installedModel } from './helpers.ts';

/** 実モデルを読まない偽の合成プロセス */
const FAKE_CHILD = fileURLToPath(new URL('./fixtures/fake-zen-child.ts', import.meta.url));

const voice = (id: string) => installedModel('zen-tts', id);
/** 偽の子は声の文字コードを返す */
const spoken = (pcm: Float32Array): string => String.fromCharCode(...pcm);

const setup = (o: { idleUnloadSec?: number } = {}) => {
  // 偽の子は modelPath のファイル名を声とする
  const registry = { modelPath: (_e: string, id: string, ext: string) => `/nonexistent/${id}${ext}`, list: () => [] } as unknown as Registry;
  const settings: Settings = { ...DEFAULT_SETTINGS, idleUnloadSec: o.idleUnloadSec ?? 0 };
  return new ZenTtsEngine({ registry, settings: () => settings, poolSize: 2, childPath: FAKE_CHILD });
};

const signal = () => new AbortController().signal;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return { promise, resolve };
};
const waitFor = async (cond: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
};
const slots = (e: ZenTtsEngine) => e.status().processes.map(p => `${p.slot}:${p.voice}`);

test('2 スロットに別々の声が載り、交互の要求で読み直さない。status().processes にスロットごとに出る', async () => {
  const engine = setup();
  const q = new SynthQueue({ concurrency: 2, max: 8 });
  const say = (v: string) => q.run(undefined, slot => engine.synthesize('あ。', voice(v), {}, signal(), slot), v).promise;
  try {
    // 最初は同時に来た A と B が別々のスロットへ
    assert.deepEqual((await Promise.all([say('A'), say('B')])).map(spoken), ['A', 'B']);
    const before = engine.status().processes;
    assert.deepEqual(before.map(p => [p.slot, p.voice, p.state]), [[0, 'A', 'idle'], [1, 'B', 'idle']]);
    for (const p of before) {
      assert.equal(typeof p.pid, 'number');
      assert.ok(p.rssBytes === null || p.rssBytes > 0);
    }
    for (const v of ['A', 'B', 'A', 'B', 'A', 'B']) assert.equal(spoken(await say(v)), v);
    // 同じ子のまま（pid が変わっていない）
    assert.deepEqual(engine.status().processes.map(p => p.pid), before.map(p => p.pid));
    // 互換のフィールドも残る
    const s = engine.status();
    assert.equal(s.loaded, 'A');
    assert.equal(s.kernel, 'fake');
    assert.equal(s.process?.pid, before[0]!.pid);
  } finally {
    await engine.close();
  }
});

test('読み込み中の子を止めても、別スロットで同じ声を待つ要求は成功する', async () => {
  const engine = setup();
  try {
    // スロット 0 で slowA を読み込み中に、スロット 1 も slowA を待つ（起動は同時に 1 つずつ）
    const ac = new AbortController();
    const first = engine.synthesize('あ。', voice('slowA'), {}, ac.signal, 0);
    const other = engine.synthesize('あ。', voice('slowA'), {}, signal(), 1);
    await waitFor(() => engine.status().processes.some(p => p.state === 'starting'), 'starting');
    // スロット 0 の要求をやめ、スロット 0 に別の声 → 読み込み中の子を止めて B で起動し直す
    ac.abort(new ApiError(504, 'timeout', 'aborted'));
    await assert.rejects(first, (e: unknown) => e instanceof ApiError && e.status === 504);
    assert.equal(spoken(await engine.synthesize('い。', voice('B'), {}, signal(), 0)), 'B');
    assert.equal(spoken(await other), 'slowA');
    assert.deepEqual(slots(engine), ['0:B', '1:slowA']);
  } finally {
    await engine.close();
  }
});

test('読み込みに失敗したら、その子を待つ要求だけが失敗する', async () => {
  const engine = setup();
  try {
    const bad = engine.synthesize('あ。', voice('badA'), {}, signal(), 0);
    const ok = engine.synthesize('あ。', voice('B'), {}, signal(), 1);
    await assert.rejects(bad, (e: unknown) => e instanceof ApiError && e.status === 503);
    assert.equal(spoken(await ok), 'B');
  } finally {
    await engine.close();
  }
});

test('追い越されてから上限を過ぎた要求は、声が違っても次の空きスロットで合成される', async () => {
  const engine = setup();
  let now = 0;
  const q = new SynthQueue({ concurrency: 2, max: 8, now: () => now, affinityMaxWaitMs: 50 });
  const started: string[] = [];
  const results: string[] = [];
  const add = (name: string, v: string, gate: Promise<void>) =>
    q.run(undefined, async slot => {
      started.push(`${name}@${slot}`);
      const pcm = await engine.synthesize('あ。', voice(v), {}, signal(), slot);
      await gate;
      results.push(`${name}:${spoken(pcm)}`);
    }, v).promise;
  try {
    const hold = deferred();
    const holdC = deferred();
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const runs = [add('a0', 'A', gates[0]!.promise), add('b0', 'B', hold.promise)];
    await waitFor(() => started.length === 2, 'a0 and b0');
    // スロット 1 は B で塞いだまま。待ちは C（最も古い）と A が 3 つ
    runs.push(add('c', 'C', holdC.promise));
    for (let i = 1; i <= 3; i++) runs.push(add(`a${i}`, 'A', gates[i]!.promise));
    // A が C を追い越す（C の起点 10）
    now = 10;
    gates[0]!.resolve();
    await waitFor(() => started.length === 3, 'a1');
    // 起点から 49: まだ追い越す
    now = 59;
    gates[1]!.resolve();
    await waitFor(() => started.length === 4, 'a2');
    // 起点から 50: C がスロット 0 に入り、C で合成される
    now = 60;
    gates[2]!.resolve();
    await waitFor(() => started.length === 5, 'c');
    assert.deepEqual(started, ['a0@0', 'b0@1', 'a1@0', 'a2@0', 'c@0']);
    await waitFor(() => slots(engine).join() === '0:C,1:B', 'C loaded on slot 0');
    holdC.resolve();
    await waitFor(() => results.includes('c:C'), 'c result');
    hold.resolve();
    gates[3]!.resolve();
    await Promise.all(runs);
  } finally {
    await engine.close();
  }
});

test('アイドル解放はスロットごと（使われ続けるスロットがあっても、使われないスロットの子は終了する）', async () => {
  const engine = setup({ idleUnloadSec: 0.3 });
  try {
    await Promise.all([
      engine.synthesize('あ。', voice('A'), {}, signal(), 0),
      engine.synthesize('あ。', voice('B'), {}, signal(), 1),
    ]);
    assert.deepEqual(slots(engine), ['0:A', '1:B']);
    const pid0 = engine.status().processes[0]!.pid;
    // スロット 0 だけ 0.1 秒おきに使い続ける
    for (let i = 0; i < 6; i++) {
      await sleep(100);
      assert.equal(spoken(await engine.synthesize('あ。', voice('A'), {}, signal(), 0)), 'A');
    }
    assert.deepEqual(slots(engine), ['0:A']);
    assert.equal(engine.status().processes[0]!.pid, pid0);
    // スロット 0 も使われなくなれば終了する
    await waitFor(() => engine.status().processes.length === 0, 'slot 0 unload');
  } finally {
    await engine.close();
  }
});
