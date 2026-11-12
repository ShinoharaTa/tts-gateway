/**
 * 合成の同時実行数と待ち行列。
 *
 * - 同時に concurrency 本。待ち行列（実行中を含まない）が max 件で満杯なら 429（queue_full、Retry-After 付き）
 * - 同じキーの要求が実行中・待ち中なら、新たに積まずにその結果を待つ（合流）。key を渡さない要求は合流しない
 * - 実行枠（スロット）は合成プロセスに対応し、最後に流した声を覚える。fn にはスロットの番号を渡す
 * - concurrency 1 は FIFO。2 以上では、空いたスロットが次の順で 1 件取る（声の読み直しを減らす）:
 *   1. 先頭（最も古い）が待ち行列に入ってから PRIORITY_AFTER_MS 以上たっていれば先頭
 *   2. 最初に追い越されてから affinityMaxWaitMs（TTS_AFFINITY_MAX_WAIT_MS）以上たった最も古い要求
 *   3. このスロットの声と同じ声の最も古い要求
 *   4. 他のスロットが読み込んでいない声の最も古い要求
 *   5. 先頭
 *   取った要求より前にあった要求は「追い越された」とし、最初に追い越された時刻を覚える
 */
import { performance } from 'node:perf_hooks';
import { ApiError } from './errors.ts';

/** 429 の Retry-After（秒） */
export const RETRY_AFTER_SEC = 5;

/** 最初に追い越されてからこれ以上たった要求は、声が違っても次に流す（TTS_AFFINITY_MAX_WAIT_MS の既定） */
export const AFFINITY_MAX_WAIT_MS = 5000;

/** 待ち行列に入ってからこれ以上たった要求は、追い越しの有無にかかわらず最優先 */
export const PRIORITY_AFTER_MS = 15_000;

type Job<T> = {
  key: string | undefined;
  voice: string | undefined;
  queuedAt: number;
  /** 最初に追い越された時刻（追い越されるまでは undefined） */
  overtakenAt: number | undefined;
  run: (slot: number) => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

type Slot = { busy: boolean; voice: string | undefined };

export class SynthQueue {
  concurrency: number;
  max: number;
  private running = 0;
  private readonly waiting: Job<unknown>[] = [];
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly slots: Slot[] = [];
  private readonly now: () => number;
  private readonly affinityMaxWaitMs: number;
  private readonly priorityAfterMs: number;

  /** now・priorityAfterMs はテスト用（既定は performance.now・PRIORITY_AFTER_MS） */
  constructor(o: {
    concurrency: number;
    max: number;
    affinityMaxWaitMs?: number;
    now?: () => number;
    priorityAfterMs?: number;
  }) {
    this.concurrency = o.concurrency;
    this.max = o.max;
    this.affinityMaxWaitMs = o.affinityMaxWaitMs ?? AFFINITY_MAX_WAIT_MS;
    this.now = o.now ?? (() => performance.now());
    this.priorityAfterMs = o.priorityAfterMs ?? PRIORITY_AFTER_MS;
  }

  stats(): { running: number; waiting: number; max: number; concurrency: number } {
    return { running: this.running, waiting: this.waiting.length, max: this.max, concurrency: this.concurrency };
  }

  /** 合流したかどうかも返す。voice は声の識別子（スロットの割り当てに使う） */
  run<T>(key: string | undefined, fn: (slot: number) => Promise<T>, voice?: string): { promise: Promise<T>; joined: boolean } {
    if (key !== undefined) {
      const same = this.inflight.get(key);
      if (same) return { promise: same as Promise<T>, joined: true };
    }
    if (this.running >= this.concurrency && this.waiting.length >= this.max) {
      const e = new ApiError(429, 'queue_full', `queue is full (${this.max} waiting)`);
      e.retryAfterSec = RETRY_AFTER_SEC;
      throw e;
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.waiting.push({ key, voice, queuedAt: this.now(), overtakenAt: undefined, run: fn, resolve, reject } as Job<unknown>);
    });
    if (key !== undefined) {
      this.inflight.set(key, promise);
      const done = (): void => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      };
      promise.then(done, done);
    }
    this.next();
    return { promise, joined: false };
  }

  private next(): void {
    while (this.slots.length < this.concurrency) this.slots.push({ busy: false, voice: undefined });
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const [slotIndex, jobIndex] = this.pick();
      const slot = this.slots[slotIndex]!;
      const now = this.now();
      for (const w of this.waiting.slice(0, jobIndex)) w.overtakenAt ??= now;
      const job = this.waiting.splice(jobIndex, 1)[0]!;
      slot.busy = true;
      slot.voice = job.voice;
      this.running++;
      void (async () => {
        try {
          job.resolve(await job.run(slotIndex));
        } catch (e) {
          job.reject(e);
        } finally {
          slot.busy = false;
          this.running--;
          this.next();
        }
      })();
    }
  }

  /** 空いたスロットと、そこで流す要求（waiting の添字）を選ぶ */
  private pick(): [slot: number, job: number] {
    const free = this.slots.flatMap((s, i) => (i < this.concurrency && !s.busy ? [i] : []));
    if (this.concurrency <= 1) return [free[0]!, 0];
    const head = this.waiting[0]!;
    // 空きが複数なら、その声を読み込んでいるスロットを優先する
    const slotFor = (voice: string | undefined): number => free.find(i => this.slots[i]!.voice === voice) ?? free[0]!;
    const now = this.now();
    if (now - head.queuedAt >= this.priorityAfterMs) return [slotFor(head.voice), 0];
    const expired = this.waiting.findIndex(w => w.overtakenAt !== undefined && now - w.overtakenAt >= this.affinityMaxWaitMs);
    if (expired >= 0) return [slotFor(this.waiting[expired]!.voice), expired];
    for (const i of free) {
      const voice = this.slots[i]!.voice;
      if (voice === undefined) continue;
      const j = this.waiting.findIndex(w => w.voice === voice);
      if (j >= 0) return [i, j];
    }
    const slot = free[0]!;
    const others = new Set(this.slots.flatMap((s, i) => (i !== slot && s.voice !== undefined ? [s.voice] : [])));
    const j = this.waiting.findIndex(w => w.voice === undefined || !others.has(w.voice));
    return [slot, j >= 0 ? j : 0];
  }
}
