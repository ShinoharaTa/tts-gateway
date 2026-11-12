import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/errors.ts';
import { AFFINITY_MAX_WAIT_MS, RETRY_AFTER_SEC, SynthQueue } from '../src/queue.ts';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
};

test('同時実行数と FIFO', async () => {
  const q = new SynthQueue({ concurrency: 1, max: 8 });
  const order: number[] = [];
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
  const runs = gates.map((g, i) =>
    q.run(undefined, async () => {
      order.push(i);
      await g.promise;
      return i;
    }).promise,
  );
  await Promise.resolve();
  assert.deepEqual(q.stats(), { running: 1, waiting: 2, max: 8, concurrency: 1 });
  gates[2]!.resolve();
  gates[1]!.resolve();
  gates[0]!.resolve();
  assert.deepEqual(await Promise.all(runs), [0, 1, 2]);
  assert.deepEqual(order, [0, 1, 2]);
  assert.equal(q.stats().running, 0);
});

test('待ち行列が上限なら 429（Retry-After 付き）', async () => {
  const q = new SynthQueue({ concurrency: 1, max: 2 });
  const gate = deferred<void>();
  const runs = [0, 1, 2].map(() => q.run(undefined, () => gate.promise).promise);
  assert.throws(
    () => q.run(undefined, async () => {}),
    (e: unknown) => e instanceof ApiError && e.status === 429 && e.code === 'queue_full' && e.retryAfterSec === RETRY_AFTER_SEC,
  );
  gate.resolve();
  await Promise.all(runs);
  // 空いたらまた受け付ける
  await q.run(undefined, async () => {}).promise;
});

test('同じキーは合流し、1 回だけ実行する', async () => {
  const q = new SynthQueue({ concurrency: 1, max: 0 });
  let calls = 0;
  const gate = deferred<string>();
  const a = q.run('k', () => {
    calls++;
    return gate.promise;
  });
  // 満杯（max 0）でも、合流は待ち行列を使わないので受け付ける
  const b = q.run('k', async () => {
    calls++;
    return 'other';
  });
  assert.equal(a.joined, false);
  assert.equal(b.joined, true);
  gate.resolve('done');
  assert.deepEqual(await Promise.all([a.promise, b.promise]), ['done', 'done']);
  assert.equal(calls, 1);
  // 終わった後の同じキーは新しく実行する
  const c = q.run('k', async () => 'again');
  assert.equal(c.joined, false);
  assert.equal(await c.promise, 'again');
});

test('失敗は合流した全員に返り、キューは止まらない', async () => {
  const q = new SynthQueue({ concurrency: 2, max: 8 });
  const a = q.run('x', async () => {
    throw new Error('boom');
  });
  const b = q.run('x', async () => 'unused');
  await assert.rejects(a.promise, /boom/);
  await assert.rejects(b.promise, /boom/);
  assert.equal(await q.run('x', async () => 'ok').promise, 'ok');
});

const flush = () => new Promise<void>(r => setImmediate(r));

test('2 スロット: 空いたスロットは同じ声 → 他のスロットに無い声 → 先頭の順で取る', async () => {
  const q = new SynthQueue({ concurrency: 2, max: 8, now: () => 0 });
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const add = (name: string, voice: string) => {
    const g = deferred<void>();
    gates.set(name, g);
    return q.run(undefined, async slot => {
      started.push(`${name}@${slot}`);
      await g.promise;
    }, voice).promise;
  };
  const runs = [add('a1', 'A'), add('b1', 'B'), add('a2', 'A'), add('c1', 'C'), add('b2', 'B'), add('a3', 'A')];
  await flush();
  assert.deepEqual(started, ['a1@0', 'b1@1']);
  // スロット 0（A）が空く → 待ちの先頭 a2（A）
  gates.get('a1')!.resolve();
  await flush();
  assert.deepEqual(started.slice(2), ['a2@0']);
  // スロット 1（B）が空く → 先頭 c1 を追い越して b2（B）
  gates.get('b1')!.resolve();
  await flush();
  assert.deepEqual(started.slice(3), ['b2@1']);
  // スロット 0（A）が空く → a3（A）
  gates.get('a2')!.resolve();
  await flush();
  assert.deepEqual(started.slice(4), ['a3@0']);
  // スロット 1（B）が空く → B は無く、C はどこにも無いので c1
  gates.get('b2')!.resolve();
  await flush();
  assert.deepEqual(started.slice(5), ['c1@1']);
  for (const g of gates.values()) g.resolve();
  await Promise.all(runs);
});

test('2 スロット: 他のスロットが読み込んでいる声は後回しにし、空きが複数ならその声のスロットへ', async () => {
  const q = new SynthQueue({ concurrency: 2, max: 8, now: () => 0 });
  const started: string[] = [];
  const gates: ReturnType<typeof deferred<void>>[] = [];
  const add = (name: string, voice: string) => {
    const g = deferred<void>();
    gates.push(g);
    return q.run(undefined, async slot => {
      started.push(`${name}@${slot}`);
      await g.promise;
    }, voice).promise;
  };
  const first = [add('a1', 'A'), add('b1', 'B')];
  await flush();
  // スロット 1（B）は合成中。スロット 0（A）が空くと、先頭の b2 ではなく c1
  const rest = [add('b2', 'B'), add('c1', 'C')];
  gates[0]!.resolve();
  await flush();
  assert.deepEqual(started, ['a1@0', 'b1@1', 'c1@0']);
  for (const g of gates) g.resolve();
  await Promise.all([...first, ...rest]);
  // 両方空いているとき、B の要求はスロット 1（B）へ
  started.length = 0;
  const b3 = add('b3', 'B');
  gates.at(-1)!.resolve();
  await b3;
  assert.deepEqual(started, ['b3@1']);
});

test(`2 スロット: 先頭が ${AFFINITY_MAX_WAIT_MS}ms 以上待ったら追い越さない`, async () => {
  let now = 0;
  const q = new SynthQueue({ concurrency: 2, max: 8, now: () => now });
  const started: string[] = [];
  const add = (name: string, voice: string, gate: Promise<void>) =>
    q.run(undefined, async slot => {
      started.push(`${name}@${slot}`);
      await gate;
    }, voice).promise;
  const hold = deferred<void>();
  const slot0 = [deferred<void>()];
  const runs = [add('a0', 'A', slot0[0]!.promise), add('b0', 'B', hold.promise)];
  await flush();
  // スロット 1 は B で塞いだまま、待ちに C（最も古い）を置き、A を足し続ける
  runs.push(add('c', 'C', Promise.resolve()));
  for (let i = 1; i <= 3; i++) {
    const g = deferred<void>();
    slot0.push(g);
    runs.push(add(`a${i}`, 'A', g.promise));
  }
  // 4.9 秒までは A が C を追い越す
  now = 4900;
  slot0[0]!.resolve();
  await flush();
  assert.deepEqual(started.slice(2), ['a1@0']);
  // 5 秒を過ぎたら、声が違っても先頭の C
  now = 5000;
  slot0[1]!.resolve();
  await flush();
  assert.deepEqual(started.slice(3, 4), ['c@0']);
  await flush();
  assert.deepEqual(started.slice(4), ['a2@0']);
  hold.resolve();
  for (const g of slot0) g.resolve();
  await Promise.all(runs);
});

test('1 スロットは声に関係なく FIFO', async () => {
  const q = new SynthQueue({ concurrency: 1, max: 8, now: () => 0 });
  const started: string[] = [];
  const gate = deferred<void>();
  const runs = ['A', 'B', 'A', 'B'].map((v, i) =>
    q.run(undefined, async slot => {
      started.push(`${v}${i}@${slot}`);
      await gate.promise;
    }, v).promise,
  );
  gate.resolve();
  await Promise.all(runs);
  assert.deepEqual(started, ['A0@0', 'B1@0', 'A2@0', 'B3@0']);
});
