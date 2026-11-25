/**
 * 設定画面で発行する期限つきの API トークン（データディレクトリの api-tokens.json、権限 0600）。通常の API だけに使える。
 *
 * - トークンの値は保存しない（sha256 のハッシュ・id・ラベル・時刻だけ）。値を返すのは発行の応答の 1 回だけ
 * - 最終使用時刻はメモリで更新し、60 秒ごとの tick() と終了時の flush() でまとめて書く
 * - ファイルが壊れていたら起動は止めず空で始める（発行済みは全部 401）。元のファイルは .broken に退避する
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { invalid } from './errors.ts';
import { log } from './log.ts';
import { writeAtomic } from './settings.ts';

export const TOKEN_RE = /^ttsg_([0-9a-f]{8})_[0-9a-f]{48}$/;
export const TOKEN_ID_RE = /^[0-9a-f]{8}$/;
/** 期限の選択肢（秒）: 1 時間・24 時間・7 日・30 日 */
export const EXPIRES_IN_SEC = [3600, 86400, 604800, 2592000] as const;
/** 期限内のトークンの数の上限 */
export const MAX_ACTIVE_TOKENS = 20;
/** 期限切れを含めたレコードの数の上限（超えたら期限切れの古いものから消す） */
export const MAX_TOKEN_RECORDS = 50;
export const MAX_LABEL_CHARS = 40;
/** 期限切れを一覧に残す時間 */
export const EXPIRED_KEEP_MS = 7 * 86_400_000;
/** 掃除と最終使用時刻の書き込みの間隔 */
export const FLUSH_INTERVAL_MS = 60_000;

export type TokenRecord = { id: string; label: string; hash: string; createdAt: string; expiresAt: string; lastUsedAt: string | null };
export type TokenView = { id: string; label: string; createdAt: string; expiresAt: string; lastUsedAt: string | null; expired: boolean };

const HASH_RE = /^[0-9a-f]{64}$/;

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

/** 秒精度の ISO（models.json の addedAt と同じ形） */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** ファイルの中身を検査する。形が合わなければ Error */
const parseFile = (text: string): TokenRecord[] => {
  const data = JSON.parse(text) as { version?: unknown; tokens?: unknown };
  if (!data || typeof data !== 'object' || data.version !== 1) throw new Error('version must be 1');
  if (!Array.isArray(data.tokens)) throw new Error('tokens must be an array');
  const ids = new Set<string>();
  return data.tokens.map((t: unknown, i: number): TokenRecord => {
    const r = t as Record<string, unknown> | null;
    const ok =
      !!r && typeof r === 'object' &&
      typeof r.id === 'string' && TOKEN_ID_RE.test(r.id) && !ids.has(r.id) &&
      typeof r.label === 'string' &&
      typeof r.hash === 'string' && HASH_RE.test(r.hash) &&
      isDate(r.createdAt) && isDate(r.expiresAt) &&
      (r.lastUsedAt === null || isDate(r.lastUsedAt));
    if (!ok) throw new Error(`tokens[${i}] is malformed`);
    ids.add(r.id as string);
    return {
      id: r.id as string, label: r.label as string, hash: r.hash as string,
      createdAt: r.createdAt as string, expiresAt: r.expiresAt as string, lastUsedAt: r.lastUsedAt as string | null,
    };
  });
};

export class TokenStore {
  readonly dataDir: string;
  private tokens: TokenRecord[];
  private readonly now: () => number;
  private writing: Promise<void> = Promise.resolve();
  /** ファイルに書いていない変更（最終使用時刻・掃除・書けなかった失効）がある */
  private dirty = false;
  /** tick() の書き込みが失敗し続けている（warn は 1 回だけ出す） */
  private failing = false;

  private constructor(dataDir: string, tokens: TokenRecord[], now: () => number) {
    this.dataDir = dataDir;
    this.tokens = tokens;
    this.now = now;
  }

  get path(): string {
    return join(this.dataDir, 'api-tokens.json');
  }

  static async load(dataDir: string, now: () => number = Date.now): Promise<TokenStore> {
    const path = join(dataDir, 'api-tokens.json');
    let tokens: TokenRecord[] = [];
    let text: string | null = null;
    try {
      text = await readFile(path, 'utf8');
      tokens = parseFile(text);
    } catch (e) {
      if (text !== null || (e as NodeJS.ErrnoException).code !== 'ENOENT') {
        tokens = [];
        await rename(path, `${path}.broken`).catch(() => {});
        log.error('api-tokens.json is unreadable; starting with no API tokens', { err: e });
      }
    }
    const store = new TokenStore(dataDir, tokens, now);
    // 読み込み時の掃除はメモリだけ（CLI がサーバーの稼働中にファイルを書き換えないように）
    store.purge();
    return store;
  }

  private isExpired(t: TokenRecord): boolean {
    return this.now() >= Date.parse(t.expiresAt);
  }

  private view(t: TokenRecord): TokenView {
    return { id: t.id, label: t.label, createdAt: t.createdAt, expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt, expired: this.isExpired(t) };
  }

  /** 期限から EXPIRED_KEEP_MS を過ぎたものを消す。消した件数を返す（1 件以上ならログ） */
  private purge(): number {
    const now = this.now();
    const before = this.tokens.length;
    this.tokens = this.tokens.filter(t => Date.parse(t.expiresAt) + EXPIRED_KEEP_MS > now);
    const count = before - this.tokens.length;
    if (count > 0) log.info('api tokens purged', { count });
    return count;
  }

  /** createdAt の新しい順（同時刻は追加の新しい順）。hash を含めない */
  list(): TokenView[] {
    return [...this.tokens]
      .reverse()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(t => this.view(t));
  }

  /** 発行する。値（token）を返すのはここだけ。保存に失敗したら登録せずに reject */
  async issue(label: string, expiresInSec: number): Promise<{ view: TokenView; token: string }> {
    this.purge();
    if (this.tokens.filter(t => !this.isExpired(t)).length >= MAX_ACTIVE_TOKENS)
      throw invalid(`too many active tokens (up to ${MAX_ACTIVE_TOKENS})`);
    if (this.tokens.length >= MAX_TOKEN_RECORDS) {
      // 期限切れを expiresAt の古い順に消す
      const expired = this.tokens.filter(t => this.isExpired(t)).sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
      const drop = new Set(expired.slice(0, this.tokens.length - MAX_TOKEN_RECORDS + 1));
      this.tokens = this.tokens.filter(t => !drop.has(t));
    }
    let id: string;
    do id = randomBytes(4).toString('hex');
    while (this.tokens.some(t => t.id === id));
    const token = `ttsg_${id}_${randomBytes(24).toString('hex')}`;
    const created = Math.floor(this.now() / 1000) * 1000;
    const rec: TokenRecord = {
      id, label, hash: sha256(token).toString('hex'),
      createdAt: iso(created), expiresAt: iso(created + expiresInSec * 1000), lastUsedAt: null,
    };
    this.tokens.push(rec);
    try {
      await this.save();
    } catch (e) {
      // 再起動で消える値を返さない
      this.tokens = this.tokens.filter(t => t !== rec);
      throw e;
    }
    return { view: this.view(rec), token };
  }

  /** 失効する（レコードを消す）。無ければ undefined。保存に失敗してもメモリでは消えたまま（tick() で書き直す） */
  async revoke(id: string): Promise<TokenRecord | undefined> {
    const rec = this.tokens.find(t => t.id === id);
    if (!rec) return undefined;
    this.tokens = this.tokens.filter(t => t !== rec);
    try {
      await this.save();
    } catch (e) {
      this.dirty = true;
      throw e;
    }
    return rec;
  }

  /** 提示された値を照合する。通れば id を返し、最終使用時刻を（メモリで）更新する */
  verify(presented: string): string | null {
    const m = TOKEN_RE.exec(presented);
    if (!m) return null;
    // id は公開してよい値なので、引くのは定数時間でなくてよい
    const rec = this.tokens.find(t => t.id === m[1]);
    if (!rec || !timingSafeEqual(sha256(presented), Buffer.from(rec.hash, 'hex'))) return null;
    if (this.isExpired(rec)) return null;
    rec.lastUsedAt = iso(this.now());
    this.dirty = true;
    return rec.id;
  }

  /** 掃除して、書いていない変更があれば書く。reject しない（失敗は次回に再試行） */
  async tick(): Promise<void> {
    if (this.purge() > 0) this.dirty = true;
    if (!this.dirty) return;
    try {
      await this.flush();
      this.failing = false;
    } catch (e) {
      if (!this.failing) log.warn('cannot write api-tokens.json', { err: e });
      this.failing = true;
    }
  }

  /** 書いていない変更があれば書く。失敗は reject */
  async flush(): Promise<void> {
    if (this.dirty) await this.save();
  }

  private save(): Promise<void> {
    const body = `${JSON.stringify({ version: 1, tokens: this.tokens }, null, 2)}\n`;
    this.dirty = false;
    this.writing = this.writing
      .catch(() => {})
      .then(() => writeAtomic(this.path, body, 0o600))
      .catch((e: unknown) => {
        this.dirty = true;
        throw e;
      });
    return this.writing;
  }
}
