/**
 * モデルの取得（docs/api.md「POST /v1/admin/models」）。
 *
 * - https のみ。ホストは TTS_MODEL_HOSTS のどれか、またはそのサブドメイン。リダイレクト先も同じ規則で検査する
 * - 上限（TTS_MODEL_MAX_MB）を超えたら止めて消す。sha256 を指定していれば一致しないと失敗
 * - <dest>.part に書き、エンジンで読み込めるか検査してから <dest> に rename する。失敗なら .part を消す
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { conflict, invalid, notFound } from '../errors.ts';
import type { Engine } from '../engines/types.ts';
import type { ModelRecord, Registry } from './registry.ts';

export const MAX_REDIRECTS = 5;

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
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void;
  signal?: AbortSignal;
};

/** URL の形とホストを検査する。だめなら理由を返す */
export const checkUrl = (raw: string, isHostAllowed: (host: string) => boolean, protocols: readonly string[] = ['https:']): string | null => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'invalid URL';
  }
  if (!protocols.includes(u.protocol)) return `URL must use ${protocols.join(' or ').replace(/:/g, '')}`;
  if (u.username || u.password) return 'URL must not contain credentials';
  if (!isHostAllowed(u.hostname)) return `host ${u.hostname} is not allowed (TTS_MODEL_HOSTS)`;
  return null;
};

/** url を dest.part に取る。戻り値は .part のパス・sha256・バイト数 */
export const downloadFile = async (o: DownloadOptions): Promise<{ partPath: string; sha256: string; bytes: number }> => {
  const protocols = o.protocols ?? ['https:'];
  let url = o.url;
  let res: Response | null = null;
  for (let hop = 0; ; hop++) {
    const bad = checkUrl(url, o.isHostAllowed, protocols);
    if (bad) throw new DownloadError(hop === 0 ? bad : `redirect to ${url}: ${bad}`);
    res = await fetch(url, { redirect: 'manual', signal: o.signal });
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
  await mkdir(dirname(partPath), { recursive: true });
  const out = createWriteStream(partPath);
  const hash = createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      if (received > o.maxBytes) throw new DownloadError(`file is too large (> ${o.maxBytes} bytes)`);
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
      o.onProgress?.(received, total);
    }
    out.end();
    await once(out, 'finish');
  } catch (e) {
    out.destroy();
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
  /** テスト用 */
  isHostAllowed?: (host: string) => boolean;
  protocols?: readonly string[];
};

/** 登録モデルの取得を管理する（1 モデルにつき同時に 1 つ） */
export class ModelDownloader {
  private readonly o: DownloaderOptions;
  private readonly active = new Map<string, { ac: AbortController; done: Promise<void> }>();
  readonly isHostAllowed: (host: string) => boolean;

  constructor(o: DownloaderOptions) {
    this.o = o;
    this.isHostAllowed = o.isHostAllowed ?? (host => hostAllowed(host, o.modelHosts));
  }

  /** POST の url の検査（400） */
  validateUrl(url: string, field = 'url'): void {
    const bad = checkUrl(url, this.isHostAllowed, this.o.protocols);
    if (bad) throw invalid(bad, field);
  }

  isActive(engine: string, id: string): boolean {
    return this.active.has(`${engine}/${id}`);
  }

  /** 取得を始める（終わるのを待たない。終わりは wait で待てる） */
  async start(rec: ModelRecord): Promise<void> {
    const k = `${rec.engine}/${rec.id}`;
    if (this.active.has(k)) throw conflict(`model ${rec.id} is already downloading`);
    const engine = this.o.engines.get(rec.engine);
    if (!engine) throw notFound(`engine ${rec.engine} not found`);
    const ac = new AbortController();
    const entry = { ac, done: Promise.resolve() };
    this.active.set(k, entry);
    await this.o.registry.update(rec.engine, rec.id, {
      status: 'downloading',
      progress: { receivedBytes: 0, totalBytes: null },
      error: null,
    });
    entry.done = this.run(rec, engine, ac.signal).finally(() => this.active.delete(k));
  }

  wait(engine: string, id: string): Promise<void> {
    return this.active.get(`${engine}/${id}`)?.done ?? Promise.resolve();
  }

  /** 取得中なら止めて、終わるのを待つ */
  async cancel(engine: string, id: string): Promise<void> {
    const a = this.active.get(`${engine}/${id}`);
    if (!a) return;
    a.ac.abort();
    await a.done;
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map(k => this.cancel(...(k.split('/') as [string, string]))));
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
      if (partPath) await rm(partPath, { force: true });
      // 削除で止めたときは登録ごと消えるので書かない
      if (signal.aborted) return;
      await reg.update(rec.engine, rec.id, { status: 'error', progress: null, error: (e as Error).message });
    }
  }
}
