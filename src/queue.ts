/**
 * 合成の同時実行数と待ち行列（FIFO）。
 *
 * - 同時に concurrency 本。待ち行列（実行中を含まない）が max 件で満杯なら 429（queue_full、Retry-After 付き）
 * - 同じキーの要求が実行中・待ち中なら、新たに積まずにその結果を待つ（合流）。key を渡さない要求は合流しない
 * - 要求ごとに signal を渡せる。abort された要求はすぐ失敗する。合成そのもの（fn に渡す signal）は、
 *   待っている要求（合流した分を含む）が全員 abort したときだけ止める。待ち中なら行列から取り除く
 * - waitTimeoutMs を渡すと、行列に入ってから実行が始まるまでがそれを超えた合成を 503（Retry-After 付き）で失敗させ、
 *   行列から取り除く
 */
import { ApiError } from './errors.ts';

/** 429・待ちの期限切れの 503 の Retry-After（秒） */
export const RETRY_AFTER_SEC = 5;

type Job = {
  key: string | undefined;
  run: (signal: AbortSignal) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  /** 合成を止める（待っている要求が全員 abort したとき） */
  ac: AbortController;
  /** 待っている要求の数 */
  waiters: number;
  promise: Promise<unknown>;
  started: boolean;
  waitTimer: NodeJS.Timeout | undefined;
};

export type RunOptions = {
  /** この要求の中断（クライアントの切断など） */
  signal?: AbortSignal;
  /** 待ち行列での待ちの上限（ms）。合流した要求では無視する（最初の要求の期限に従う） */
  waitTimeoutMs?: number;
};

export class SynthQueue {
  concurrency: number;
  max: number;
  private running = 0;
  private readonly waiting: Job[] = [];
  private readonly inflight = new Map<string, Job>();

  constructor(o: { concurrency: number; max: number }) {
    this.concurrency = o.concurrency;
    this.max = o.max;
  }

  stats(): { running: number; waiting: number; max: number; concurrency: number } {
    return { running: this.running, waiting: this.waiting.length, max: this.max, concurrency: this.concurrency };
  }

  /** 合流したかどうかも返す */
  run<T>(key: string | undefined, fn: (signal: AbortSignal) => Promise<T>, o: RunOptions = {}): { promise: Promise<T>; joined: boolean } {
    if (key !== undefined) {
      const same = this.inflight.get(key);
      if (same) return { promise: this.wait(same, o.signal) as Promise<T>, joined: true };
    }
    if (this.running >= this.concurrency && this.waiting.length >= this.max) {
      const e = new ApiError(429, 'queue_full', `queue is full (${this.max} waiting)`);
      e.retryAfterSec = RETRY_AFTER_SEC;
      throw e;
    }
    const job = { key, run: fn, ac: new AbortController(), waiters: 0, started: false, waitTimer: undefined } as unknown as Job;
    job.promise = new Promise<unknown>((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    // 待っている要求が全員 abort した後の失敗を未処理にしない
    job.promise.catch(() => {});
    if (key !== undefined) this.inflight.set(key, job);
    const done = (): void => this.forget(job);
    job.promise.then(done, done);
    this.waiting.push(job);
    if (o.waitTimeoutMs !== undefined) {
      const sec = Math.round(o.waitTimeoutMs / 1000);
      job.waitTimer = setTimeout(() => {
        const e = new ApiError(503, 'engine_unavailable', `waited in the queue longer than ${sec}s`);
        e.retryAfterSec = RETRY_AFTER_SEC;
        this.drop(job, e);
      }, o.waitTimeoutMs);
    }
    const promise = this.wait(job, o.signal) as Promise<T>;
    this.next();
    return { promise, joined: false };
  }

  /** job の結果を待つ。signal が abort されたらこの要求だけ先に失敗し、最後の 1 人なら合成も止める */
  private wait(job: Job, signal: AbortSignal | undefined): Promise<unknown> {
    job.waiters++;
    if (!signal) return job.promise;
    return new Promise((resolve, reject) => {
      let left = false;
      const leave = (): void => {
        if (left) return;
        left = true;
        reject(signal.reason);
        if (--job.waiters === 0) this.drop(job, signal.reason);
      };
      if (signal.aborted) {
        leave();
        return;
      }
      signal.addEventListener('abort', leave, { once: true });
      job.promise.then(
        v => {
          signal.removeEventListener('abort', leave);
          if (!left) resolve(v);
        },
        e => {
          signal.removeEventListener('abort', leave);
          if (!left) reject(e);
        },
      );
    });
  }

  /** job をやめる。待ち中なら行列から取り除き、実行中なら fn の signal を abort する。以後の同じキーは新しく実行する */
  private drop(job: Job, reason: unknown): void {
    this.forget(job);
    const i = this.waiting.indexOf(job);
    if (i >= 0) {
      this.waiting.splice(i, 1);
      job.reject(reason);
    } else if (job.started) {
      job.ac.abort(reason);
    }
  }

  private forget(job: Job): void {
    clearTimeout(job.waitTimer);
    if (job.key !== undefined && this.inflight.get(job.key) === job) this.inflight.delete(job.key);
  }

  private next(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      clearTimeout(job.waitTimer);
      job.started = true;
      this.running++;
      void (async () => {
        try {
          job.resolve(await job.run(job.ac.signal));
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
