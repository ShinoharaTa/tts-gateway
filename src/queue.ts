/**
 * 合成の同時実行数と待ち行列。
 *
 * - 同時に concurrency 本。待ち行列（実行中を含まない）が max 件で満杯なら 429（queue_full、Retry-After 付き）
 * - 同じキーの要求が実行中・待ち中なら、新たに積まずにその結果を待つ（合流）。key を渡さない要求は合流しない
 * - 実行枠（スロット）は合成プロセスに対応し、最後に流した声を覚える。fn にはスロットの番号と signal を渡す
 * - concurrency 1 は FIFO。2 以上では、空いたスロットが次の順で 1 件取る（声の読み直しを減らす）:
 *   1. 先頭（最も古い）が待ち行列に入ってから PRIORITY_AFTER_MS 以上たっていれば先頭
 *   2. 最初に追い越されてから affinityMaxWaitMs（TTS_AFFINITY_MAX_WAIT_MS）以上たった最も古い要求
 *   3. このスロットの声と同じ声の最も古い要求
 *   4. 他のスロットが読み込んでいない声の最も古い要求
 *   5. 先頭
 *   取った要求より前にあった要求は「追い越された」とし、最初に追い越された時刻を覚える
 *   空きスロットが複数あり、どれも要求の声を持っていなければ、未読み込みのスロット → 最後に割り当てた時刻が最も古いスロットの順
 * - 要求ごとに signal を渡せる。abort された要求はすぐ失敗する。合成そのもの（fn に渡す signal）は、
 *   待っている要求（合流した分を含む）が全員 abort したときだけ止める。待ち中なら行列から取り除く
 * - waitTimeoutMs を渡すと、行列に入ってから実行が始まるまでがそれを超えた合成を 503（Retry-After 付き）で失敗させ、
 *   行列から取り除く
 */
import { performance } from 'node:perf_hooks';
import { ApiError } from './errors.ts';

/** 429・待ちの期限切れの 503 の Retry-After（秒） */
export const RETRY_AFTER_SEC = 5;

/** 最初に追い越されてからこれ以上たった要求は、声が違っても次に流す（TTS_AFFINITY_MAX_WAIT_MS の既定） */
export const AFFINITY_MAX_WAIT_MS = 5000;

/** 待ち行列に入ってからこれ以上たった要求は、追い越しの有無にかかわらず最優先 */
export const PRIORITY_AFTER_MS = 15_000;

type Job = {
  key: string | undefined;
  voice: string | undefined;
  queuedAt: number;
  /** 最初に追い越された時刻（追い越されるまでは undefined） */
  overtakenAt: number | undefined;
  run: (slot: number, signal: AbortSignal) => Promise<unknown>;
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

/** lastUsedAt: 最後に要求を割り当てた時刻（未使用は -Infinity） */
type Slot = { busy: boolean; voice: string | undefined; lastUsedAt: number };

export class SynthQueue {
  concurrency: number;
  max: number;
  private running = 0;
  private readonly waiting: Job[] = [];
  private readonly inflight = new Map<string, Job>();
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
  run<T>(
    key: string | undefined,
    fn: (slot: number, signal: AbortSignal) => Promise<T>,
    voice?: string,
    o: RunOptions = {},
  ): { promise: Promise<T>; joined: boolean } {
    if (key !== undefined) {
      const same = this.inflight.get(key);
      if (same) return { promise: this.wait(same, o.signal) as Promise<T>, joined: true };
    }
    if (this.running >= this.concurrency && this.waiting.length >= this.max) {
      const e = new ApiError(429, 'queue_full', `queue is full (${this.max} waiting)`);
      e.retryAfterSec = RETRY_AFTER_SEC;
      throw e;
    }
    const job = {
      key, voice, queuedAt: this.now(), overtakenAt: undefined, run: fn,
      ac: new AbortController(), waiters: 0, started: false, waitTimer: undefined,
    } as unknown as Job;
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
    while (this.slots.length < this.concurrency) this.slots.push({ busy: false, voice: undefined, lastUsedAt: -Infinity });
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const [slotIndex, jobIndex] = this.pick();
      const slot = this.slots[slotIndex]!;
      const now = this.now();
      for (const w of this.waiting.slice(0, jobIndex)) w.overtakenAt ??= now;
      const job = this.waiting.splice(jobIndex, 1)[0]!;
      clearTimeout(job.waitTimer);
      job.started = true;
      slot.busy = true;
      slot.voice = job.voice;
      slot.lastUsedAt = now;
      this.running++;
      void (async () => {
        try {
          job.resolve(await job.run(slotIndex, job.ac.signal));
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
    // 声を持っていない空きスロット → 最後に割り当てた時刻が最も古い空きスロット（同時刻なら番号の小さい方）
    const spare = (): number =>
      free.find(i => this.slots[i]!.voice === undefined) ??
      free.reduce((a, i) => (this.slots[i]!.lastUsedAt < this.slots[a]!.lastUsedAt ? i : a));
    // 空きが複数なら、その声を読み込んでいるスロットを優先する
    const slotFor = (voice: string | undefined): number => free.find(i => this.slots[i]!.voice === voice) ?? spare();
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
    const slot = spare();
    const others = new Set(this.slots.flatMap((s, i) => (i !== slot && s.voice !== undefined ? [s.voice] : [])));
    const j = this.waiting.findIndex(w => w.voice === undefined || !others.has(w.voice));
    return [slot, j >= 0 ? j : 0];
  }
}
