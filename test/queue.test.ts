import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/errors.ts';
import { RETRY_AFTER_SEC, SynthQueue } from '../src/queue.ts';

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
