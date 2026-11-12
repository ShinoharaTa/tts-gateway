/**
 * 音声のディスクキャッシュ。<dir>/<key>.audio（本文）と <dir>/<key>.json（メタ）。
 *
 * - キーは synthesize.ts の cacheKey（sha256 の 16 進）
 * - maxBytes を超えたら最終アクセスの古い順に消す。作ってから ttl を過ぎたものも消す
 * - maxBytes が 0 ならキャッシュ無効（読まず書かない）
 * - 起動時にディレクトリを読み直す（メタの lastAccess で LRU を続ける）
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type CacheMeta = {
  key: string;
  contentType: string;
  durationMs: number;
  sampleRate: number;
  bytes: number;
  createdAt: number;
  lastAccess: number;
};

const KEY_RE = /^[0-9a-f]{64}$/;

export type CacheOptions = {
  dir: string;
  /** 設定で変わるので関数で受ける */
  maxBytes: () => number;
  ttlMs: () => number;
  now?: () => number;
};

export class AudioCache {
  private readonly dir: string;
  private readonly maxBytes: () => number;
  private readonly ttlMs: () => number;
  private readonly now: () => number;
  private readonly index = new Map<string, CacheMeta>();
  private total = 0;

  constructor(o: CacheOptions) {
    this.dir = o.dir;
    this.maxBytes = o.maxBytes;
    this.ttlMs = o.ttlMs;
    this.now = o.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.maxBytes() > 0;
  }

  /** ディレクトリのメタを読む（壊れたメタ・本文の無いものは消す） */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const names = await readdir(this.dir);
    const audio = new Set(names.filter(n => n.endsWith('.audio')).map(n => n.slice(0, -6)));
    for (const name of names) {
      if (!name.endsWith('.json')) {
        if (name.endsWith('.tmp')) await rm(join(this.dir, name), { force: true });
        continue;
      }
      const key = name.slice(0, -5);
      try {
        const meta = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as CacheMeta;
        if (!KEY_RE.test(key) || meta.key !== key || !audio.has(key)) throw new Error('broken');
        this.index.set(key, meta);
        this.total += meta.bytes;
        audio.delete(key);
      } catch {
        await this.removeFiles(key);
      }
    }
    for (const key of audio) await rm(join(this.dir, `${key}.audio`), { force: true });
    await this.evict();
  }

  stats(): { entries: number; bytes: number; maxBytes: number } {
    return { entries: this.index.size, bytes: this.total, maxBytes: this.maxBytes() };
  }

  async get(key: string): Promise<{ data: Buffer; meta: CacheMeta } | null> {
    if (!this.enabled) return null;
    const meta = this.index.get(key);
    if (!meta) return null;
    const now = this.now();
    if (now - meta.createdAt > this.ttlMs()) {
      await this.delete(key);
      return null;
    }
    let data: Buffer;
    try {
      data = await readFile(join(this.dir, `${key}.audio`));
    } catch {
      await this.delete(key);
      return null;
    }
    meta.lastAccess = now;
    await writeJson(join(this.dir, `${key}.json`), meta).catch(() => {});
    return { data, meta };
  }

  async put(key: string, data: Buffer, m: Omit<CacheMeta, 'key' | 'bytes' | 'createdAt' | 'lastAccess'>): Promise<void> {
    if (!this.enabled || !KEY_RE.test(key)) return;
    if (data.length > this.maxBytes()) return;
    const now = this.now();
    const meta: CacheMeta = { ...m, key, bytes: data.length, createdAt: now, lastAccess: now };
    const prev = this.index.get(key);
    if (prev) this.total -= prev.bytes;
    const tmp = join(this.dir, `${key}.audio.tmp`);
    await mkdir(this.dir, { recursive: true });
    await writeFile(tmp, data);
    await rename(tmp, join(this.dir, `${key}.audio`));
    await writeJson(join(this.dir, `${key}.json`), meta);
    this.index.set(key, meta);
    this.total += meta.bytes;
    await this.evict();
  }

  /** TTL を過ぎたものと、maxBytes を超えた分（最終アクセスの古い順）を消す */
  async evict(): Promise<void> {
    const now = this.now();
    const ttl = this.ttlMs();
    for (const [key, meta] of [...this.index]) {
      if (now - meta.createdAt > ttl) await this.delete(key);
    }
    const max = this.maxBytes();
    if (this.total <= max) return;
    const byAge = [...this.index.values()].sort((a, b) => a.lastAccess - b.lastAccess);
    for (const meta of byAge) {
      if (this.total <= max) break;
      await this.delete(meta.key);
    }
  }

  async clear(): Promise<void> {
    for (const key of [...this.index.keys()]) await this.delete(key);
  }

  private async delete(key: string): Promise<void> {
    const meta = this.index.get(key);
    if (meta) this.total -= meta.bytes;
    this.index.delete(key);
    await this.removeFiles(key);
  }

  private async removeFiles(key: string): Promise<void> {
    await rm(join(this.dir, `${key}.audio`), { force: true });
    await rm(join(this.dir, `${key}.json`), { force: true });
  }
}

const writeJson = async (path: string, value: unknown): Promise<void> => {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
};
