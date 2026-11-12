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

/** signal が abort されたら reason で失敗し、gate が開いたら成功する fn。最後に渡された signal を stop() で返す */
const abortable = (gate: Promise<string>) => {
  let last: AbortSignal | undefined;
  const fn = (s: AbortSignal): Promise<string> => {
    last = s;
    return new Promise((resolve, reject) => {
      void gate.then(resolve);
      s.addEventListener('abort', () => reject(s.reason));
    });
  };
  return { fn, stop: () => last! };
};

test('待ち行列での待ちが期限を超えたら 503（Retry-After 付き）で失敗し、行列から取り除く', async () => {
  const q = new SynthQueue({ concurrency: 1, max: 1 });
  const gate = deferred<void>();
  const first = q.run(undefined, () => gate.promise, { waitTimeoutMs: 50 });
  let ran = false;
  const second = q.run('k', async () => {
    ran = true;
  }, { waitTimeoutMs: 50 });
  // 合流した要求にも同じ失敗が返る
  const joined = q.run('k', async () => {});
  assert.equal(joined.joined, true);
  for (const p of [second.promise, joined.promise]) {
    await assert.rejects(
      p,
      (e: unknown) => e instanceof ApiError && e.status === 503 && e.code === 'engine_unavailable' && e.retryAfterSec === RETRY_AFTER_SEC,
    );
  }
  // 行列から消えている（満杯にならない）。同じキーは新しく積む
  assert.deepEqual(q.stats(), { running: 1, waiting: 0, max: 1, concurrency: 1 });
  const third = q.run('k', async () => 'third');
  assert.equal(third.joined, false);
  // 実行中の first は期限の対象外
  gate.resolve();
  await first.promise;
  assert.equal(await third.promise, 'third');
  assert.equal(ran, false);
});

test('待ち中に abort された要求は行列から取り除き、実行しない', async () => {
  const q = new SynthQueue({ concurrency: 1, max: 1 });
  const gate = deferred<void>();
  const first = q.run(undefined, () => gate.promise);
  const ac = new AbortController();
  let ran = false;
  const second = q.run('k', async () => {
    ran = true;
  }, { signal: ac.signal });
  assert.equal(q.stats().waiting, 1);
  const reason = new Error('gone');
  ac.abort(reason);
  await assert.rejects(second.promise, (e: unknown) => e === reason);
  assert.equal(q.stats().waiting, 0);
  gate.resolve();
  await first.promise;
  await new Promise(r => setTimeout(r, 10));
  assert.equal(ran, false);
});

test('実行中の abort: 合流した要求が残っていれば止めず、全員が abort したら fn の signal を abort する', async () => {
  const q = new SynthQueue({ concurrency: 1, max: 8 });
  const gate = deferred<string>();
  const one = abortable(gate.promise);
  const acs = [new AbortController(), new AbortController()];
  const a = q.run('k', one.fn, { signal: acs[0]!.signal });
  const b = q.run('k', one.fn, { signal: acs[1]!.signal });
  assert.equal(b.joined, true);
  acs[0]!.abort(new Error('a gone'));
  await assert.rejects(a.promise, /a gone/);
  assert.equal(one.stop().aborted, false);
  gate.resolve('done');
  assert.equal(await b.promise, 'done');

  // 今度は全員が abort する
  const two = abortable(deferred<string>().promise);
  const acs2 = [new AbortController(), new AbortController()];
  const c = q.run('k2', two.fn, { signal: acs2[0]!.signal });
  const d = q.run('k2', two.fn, { signal: acs2[1]!.signal });
  acs2[0]!.abort(new Error('c gone'));
  assert.equal(two.stop().aborted, false);
  acs2[1]!.abort(new Error('d gone'));
  await assert.rejects(c.promise, /c gone/);
  await assert.rejects(d.promise, /d gone/);
  assert.equal(two.stop().aborted, true);
  // 止めた合成には合流しない。スロットも空く
  const e = q.run('k2', async () => 'new');
  assert.equal(e.joined, false);
  assert.equal(await e.promise, 'new');
  assert.equal(q.stats().running, 0);
});

test('signal を渡さない要求が合流していれば、ほかが abort しても止めない', async () => {
  const q = new SynthQueue({ concurrency: 1, max: 8 });
  const gate = deferred<string>();
  const one = abortable(gate.promise);
  const ac = new AbortController();
  const a = q.run('k', one.fn, { signal: ac.signal });
  const b = q.run('k', async () => 'unused');
  ac.abort(new Error('gone'));
  await assert.rejects(a.promise, /gone/);
  assert.equal(one.stop().aborted, false);
  gate.resolve('done');
  assert.equal(await b.promise, 'done');
});
