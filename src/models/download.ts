/**
 * モデルの取得（docs/api.md「POST /v1/admin/models」）。
 *
 * - https のみ・ポートは 443 のみ。ホストは TTS_MODEL_HOSTS のどれか、またはそのサブドメイン。
 *   リダイレクト先も同じ規則で検査する（最大 MAX_REDIRECTS 回）
 * - 上限（TTS_MODEL_MAX_MB）を超えたら止めて消す。sha256 を指定していれば一致しないと失敗
 * - 全体で TTS_MODEL_TIMEOUT_SEC、無通信で IDLE_TIMEOUT_MS を超えたら失敗
 * - <dest>.part に書き、エンジンで読み込めるか検査してから <dest> に rename する。失敗なら .part を消す
 *   （書き込みストリームが閉じるのを待ってから消す。待たないと消した後に作られることがある）
 * - 同時に MAX_ACTIVE_DOWNLOADS 件まで（超えたら 429）
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { ApiError, conflict, invalid, notFound } from '../errors.ts';
import type { Engine } from '../engines/types.ts';
import type { ModelRecord, Registry } from './registry.ts';

export const MAX_REDIRECTS = 5;
/** 無通信の上限 */
export const IDLE_TIMEOUT_MS = 30_000;
/** 同時に取得する数の上限 */
export const MAX_ACTIVE_DOWNLOADS = 2;
/** 同時取得の上限を超えたときの Retry-After（秒） */
export const DOWNLOAD_RETRY_AFTER_SEC = 5;
/** 許可するポート */
export const ALLOWED_PORT = 443;

/** host が allowed のどれか、またはそのサブドメインか */
export const hostAllowed = (host: string, allowed: readonly string[]): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowed.some(a => h === a || h.endsWith(`.${a}`));
};

export class DownloadError extends Error {}

export type DownloadOptions = {
  url: string;
  /** 書き込み先（.part ではない最終のパス） */
  dest: string;
  sha256?: string | null;
  maxBytes: number;
  isHostAllowed: (host: string) => boolean;
  /** 既定は https: だけ（テストでは http: を足す） */
  protocols?: readonly string[];
  /** 既定は 443 だけ（テストではローカルサーバーのポートを許す） */
  isPortAllowed?: (port: number) => boolean;
  /** 全体の上限（ミリ秒）。省略時は無し */
  timeoutMs?: number;
  /** 無通信の上限（ミリ秒）。既定 IDLE_TIMEOUT_MS */
  idleTimeoutMs?: number;
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void;
  signal?: AbortSignal;
};

const defaultPortAllowed = (port: number): boolean => port === ALLOWED_PORT;

/** URL の形・ポート・ホストを検査する。だめなら理由を返す */
export const checkUrl = (
  raw: string,
  isHostAllowed: (host: string) => boolean,
  protocols: readonly string[] = ['https:'],
  isPortAllowed: (port: number) => boolean = defaultPortAllowed,
): string | null => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'invalid URL';
  }
  if (!protocols.includes(u.protocol)) return `URL must use ${protocols.join(' or ').replace(/:/g, '')}`;
  if (u.username || u.password) return 'URL must not contain credentials';
  // URL は既定のポート（https の 443）を空にする
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!isPortAllowed(port)) return `port ${port} is not allowed (only ${ALLOWED_PORT})`;
  if (!isHostAllowed(u.hostname)) return `host ${u.hostname} is not allowed (TTS_MODEL_HOSTS)`;
  return null;
};

/** url を dest.part に取る。戻り値は .part のパス・sha256・バイト数 */
export const downloadFile = async (o: DownloadOptions): Promise<{ partPath: string; sha256: string; bytes: number }> => {
  const protocols = o.protocols ?? ['https:'];
  const idleMs = o.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  // タイムアウトは timeout で止め、その理由を投げる（呼び出し側の signal での中止とは分ける）
  const timeout = new AbortController();
  const signal = o.signal ? AbortSignal.any([o.signal, timeout.signal]) : timeout.signal;
  let timedOut: DownloadError | null = null;
  const fail = (message: string): void => {
    timedOut ??= new DownloadError(message);
    timeout.abort(timedOut);
  };
  const totalTimer = o.timeoutMs === undefined ? undefined : setTimeout(() => fail(`timed out (${o.timeoutMs! / 1000} s)`), o.timeoutMs);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const kick = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(`no data received for ${idleMs / 1000} s`), idleMs);
  };
  try {
    return await fetchToPart(o, protocols, signal, kick);
  } catch (e) {
    throw timedOut ?? e;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
  }
};

const fetchToPart = async (
  o: DownloadOptions,
  protocols: readonly string[],
  signal: AbortSignal,
  kick: () => void,
): Promise<{ partPath: string; sha256: string; bytes: number }> => {
  let url = o.url;
  let res: Response | null = null;
  for (let hop = 0; ; hop++) {
    const bad = checkUrl(url, o.isHostAllowed, protocols, o.isPortAllowed);
    if (bad) throw new DownloadError(hop === 0 ? bad : `redirect to ${url}: ${bad}`);
    kick();
    res = await fetch(url, { redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel();
      if (!loc) throw new DownloadError(`HTTP ${res.status} without Location`);
      if (hop >= MAX_REDIRECTS) throw new DownloadError('too many redirects');
      url = new URL(loc, url).toString();
      continue;
    }
    break;
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new DownloadError(`HTTP ${res.status}`);
  }
  const lenHeader = res.headers.get('content-length');
  const total = lenHeader && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null;
  if (total !== null && total > o.maxBytes) {
    await res.body.cancel();
    throw new DownloadError(`file is too large (${total} bytes > ${o.maxBytes})`);
  }

  const partPath = `${o.dest}.part`;
  const writeFailed = (e: unknown): DownloadError =>
    new DownloadError(`failed to write the file (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  try {
    await mkdir(dirname(partPath), { recursive: true });
  } catch (e) {
    await res.body.cancel();
    throw writeFailed(e);
  }
  const out = createWriteStream(partPath);
  // 'error'（ENOSPC・EACCES など）は必ず受ける。受けないと uncaughtException になる
  let writeError: Error | null = null;
  out.on('error', e => {
    writeError ??= e;
  });
  const closed = new Promise<void>(r => out.once('close', () => r()));
  const hash = createHash('sha256');
  let received = 0;
  try {
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        kick();
        received += chunk.length;
        if (received > o.maxBytes) throw new DownloadError(`file is too large (> ${o.maxBytes} bytes)`);
        hash.update(chunk);
        if (writeError) throw writeError;
        if (!out.write(chunk)) await once(out, 'drain', { signal });
        o.onProgress?.(received, total);
      }
      if (writeError) throw writeError;
      out.end();
      await once(out, 'finish', { signal });
      await closed;
    } catch (e) {
      throw writeError ? writeFailed(writeError) : e;
    }
  } catch (e) {
    out.destroy();
    // 閉じる（open が終わる）のを待ってから消す
    await closed;
    await rm(partPath, { force: true });
    throw e;
  }
  const sha256 = hash.digest('hex');
  if (o.sha256 && o.sha256.toLowerCase() !== sha256) {
    await rm(partPath, { force: true });
    throw new DownloadError(`sha256 mismatch (expected ${o.sha256}, got ${sha256})`);
  }
  return { partPath, sha256, bytes: received };
};

export type DownloaderOptions = {
  registry: Registry;
  engines: ReadonlyMap<string, Engine>;
  modelHosts: readonly string[];
  maxBytes: number;
  /** 1 件の取得の上限（ミリ秒、TTS_MODEL_TIMEOUT_SEC） */
  timeoutMs: number;
  /** テスト用 */
  isHostAllowed?: (host: string) => boolean;
  protocols?: readonly string[];
  isPortAllowed?: (port: number) => boolean;
  idleTimeoutMs?: number;
};

/** 登録モデルの取得を管理する（1 モデルにつき同時に 1 つ、全体で MAX_ACTIVE_DOWNLOADS まで） */
export class ModelDownloader {
  private readonly o: DownloaderOptions;
  private readonly active = new Map<string, { ac: AbortController; done: Promise<void> }>();
  /** 削除の処理中のもの（キー → 処理中の削除の数） */
  private readonly deleting = new Map<string, number>();
  readonly isHostAllowed: (host: string) => boolean;

  constructor(o: DownloaderOptions) {
    this.o = o;
    this.isHostAllowed = o.isHostAllowed ?? (host => hostAllowed(host, o.modelHosts));
  }

  /** POST の url の検査（400） */
  validateUrl(url: string, field = 'url'): void {
    const bad = checkUrl(url, this.isHostAllowed, this.o.protocols, this.o.isPortAllowed);
    if (bad) throw invalid(bad, field);
  }

  isActive(engine: string, id: string): boolean {
    return this.active.has(`${engine}/${id}`);
  }

  isDeleting(engine: string, id: string): boolean {
    return this.deleting.has(`${engine}/${id}`);
  }

  /** 同時取得の上限なら 429 */
  checkCapacity(): void {
    if (this.active.size < MAX_ACTIVE_DOWNLOADS) return;
    const e = new ApiError(429, 'queue_full', `too many downloads (up to ${MAX_ACTIVE_DOWNLOADS} at a time)`);
    e.retryAfterSec = DOWNLOAD_RETRY_AFTER_SEC;
    throw e;
  }

  /** 取得を始める（終わるのを待たない。終わりは wait で待てる） */
  async start(rec: ModelRecord): Promise<void> {
    const k = `${rec.engine}/${rec.id}`;
    if (this.deleting.has(k)) throw conflict(`model ${rec.id} is being deleted`);
    if (this.active.has(k)) throw conflict(`model ${rec.id} is already downloading`);
    const engine = this.o.engines.get(rec.engine);
    if (!engine) throw notFound(`engine ${rec.engine} not found`);
    this.checkCapacity();
    const ac = new AbortController();
    const started = this.o.registry.update(rec.engine, rec.id, {
      status: 'downloading',
      progress: { receivedBytes: 0, totalBytes: null },
      error: null,
    });
    // await の前に active に入れる（重なった要求・削除がこれを見る）
    const done = (async () => {
      try {
        await started;
        await this.run(rec, engine, ac.signal);
      } catch {
        // started の失敗は start が投げる。run は投げない
      } finally {
        this.active.delete(k);
      }
    })();
    this.active.set(k, { ac, done });
    await started;
  }

  wait(engine: string, id: string): Promise<void> {
    return this.active.get(`${engine}/${id}`)?.done ?? Promise.resolve();
  }

  /** 取得中なら止めて、終わる（.part を消す）のを待つ */
  async cancel(engine: string, id: string): Promise<void> {
    const a = this.active.get(`${engine}/${id}`);
    if (!a) return;
    a.ac.abort();
    await a.done;
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map(k => this.cancel(...(k.split('/') as [string, string]))));
  }

  /**
   * 削除する。取得中なら止めて終わるのを待ってから fn（登録とファイルを消す）を呼ぶ。
   * その間、同じモデルの取得（追加・取り直し）は 409 になる
   */
  async remove(engine: string, id: string, fn: () => Promise<void>): Promise<void> {
    const k = `${engine}/${id}`;
    this.deleting.set(k, (this.deleting.get(k) ?? 0) + 1);
    try {
      await this.cancel(engine, id);
      await fn();
    } finally {
      const n = this.deleting.get(k)! - 1;
      if (n > 0) this.deleting.set(k, n);
      else this.deleting.delete(k);
    }
  }

  private async run(rec: ModelRecord, engine: Engine, signal: AbortSignal): Promise<void> {
    const reg = this.o.registry;
    const dest = reg.modelPath(rec.engine, rec.id, engine.modelExt);
    let partPath: string | null = null;
    try {
      const r = await downloadFile({
        url: rec.source.url,
        dest,
        sha256: rec.source.sha256,
        maxBytes: this.o.maxBytes,
        isHostAllowed: this.isHostAllowed,
        protocols: this.o.protocols,
        isPortAllowed: this.o.isPortAllowed,
        timeoutMs: this.o.timeoutMs,
        idleTimeoutMs: this.o.idleTimeoutMs,
        signal,
        onProgress: (receivedBytes, totalBytes) => {
          void reg.update(rec.engine, rec.id, { progress: { receivedBytes, totalBytes } }, false);
        },
      });
      partPath = r.partPath;
      if (signal.aborted) throw new DownloadError('aborted');
      await reg.update(rec.engine, rec.id, { status: 'verifying', progress: null });
      try {
        await engine.verifyModel(partPath);
      } catch (e) {
        throw new DownloadError(`the engine could not load the file: ${(e as Error).message}`);
      }
      if (signal.aborted) throw new DownloadError('aborted');
      await rename(partPath, dest);
      partPath = null;
      // sha256 を省略して登録したものは、取得したファイルの値を記録する（以後の取り直しはその値で検査）
      await reg.update(rec.engine, rec.id, {
        status: 'installed',
        bytes: r.bytes,
        progress: null,
        error: null,
        source: { url: rec.source.url, sha256: rec.source.sha256 ?? r.sha256 },
      });
    } catch (e) {
      try {
        if (partPath) await rm(partPath, { force: true });
        // 削除で止めたときは登録ごと消えるので書かない
        if (signal.aborted) return;
        await reg.update(rec.engine, rec.id, { status: 'error', progress: null, error: (e as Error).message });
      } catch (e2) {
        // models.json を書けないときなど。ここで投げると unhandledRejection になる
        console.error(`model ${rec.engine}/${rec.id}: failed to record the error: ${(e2 as Error).message}`);
      }
    }
  }
}
