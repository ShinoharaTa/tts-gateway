/**
 * 合成の同時実行数と待ち行列（FIFO）。
 *
 * - 同時に concurrency 本。待ち行列（実行中を含まない）が max 件で満杯なら 429（queue_full、Retry-After 付き）
 * - 同じキーの要求が実行中・待ち中なら、新たに積まずにその結果を待つ（合流）。key を渡さない要求は合流しない
 */
import { ApiError } from './errors.ts';

/** 429 の Retry-After（秒） */
export const RETRY_AFTER_SEC = 5;

type Job<T> = { key: string | undefined; run: () => Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };

export class SynthQueue {
  concurrency: number;
  max: number;
  private running = 0;
  private readonly waiting: Job<unknown>[] = [];
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(o: { concurrency: number; max: number }) {
    this.concurrency = o.concurrency;
    this.max = o.max;
  }

  stats(): { running: number; waiting: number; max: number; concurrency: number } {
    return { running: this.running, waiting: this.waiting.length, max: this.max, concurrency: this.concurrency };
  }

  /** 合流したかどうかも返す */
  run<T>(key: string | undefined, fn: () => Promise<T>): { promise: Promise<T>; joined: boolean } {
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
      this.waiting.push({ key, run: fn, resolve, reject } as Job<unknown>);
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
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      this.running++;
      void (async () => {
        try {
          job.resolve(await job.run());
        } catch (e) {
          job.reject(e);
        } finally {
          this.running--;
          this.next();
        }
      })();
    }
  }
}
