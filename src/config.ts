/**
 * 環境変数 → Config。既定値と検証はここだけで持つ（README「環境変数」）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { isLoopback, isUnspecified, parseCidr, type Cidr } from './net.ts';

/** リポジトリのルート（dict/・catalog/・public/ の場所） */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION: string = (JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }).version;

export type Config = {
  hosts: string[];
  port: number;
  allowCidrs: Cidr[];
  /** Host ヘッダに許すホスト名（小文字。ポートは問わない）。TTS_HOSTS の各アドレスとの組は別に許す */
  allowedHosts: string[];
  /** 1 待ち受けあたりの同時接続の上限 */
  maxConnections: number;
  /** 空なら認証しない */
  token: string;
  /** 空なら /v1/admin/* も token の規則 */
  adminToken: string;
  dataDir: string;
  cacheDir: string;
  concurrency: number;
  queueMax: number;
  maxChars: number;
  timeoutSec: number;
  modelHosts: string[];
  modelMaxBytes: number;
  ffmpeg: string;
  packageDir: string;
};

type Env = Record<string, string | undefined>;

const list = (v: string): string[] =>
  v
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const int = (env: Env, name: string, def: number, min: number, max: number): number => {
  const raw = env[name]?.trim();
  if (!raw) return def;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be an integer (got ${JSON.stringify(raw)})`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max} (got ${n})`);
  return n;
};

/** 推測されやすいトークン（.env.example の例そのままなど）は起動時エラー */
const PLACEHOLDER_TOKEN = 'change-me';
const MIN_TOKEN_CHARS = 16;

/** warn: 起動を止めない注意（1 件 1 行） */
export const loadConfig = (env: Env = process.env, warn: (msg: string) => void = console.error): Config => {
  const home = env.HOME || homedir();
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const cacheHome = env.XDG_CACHE_HOME || join(home, '.cache');

  const hosts = list(env.TTS_HOSTS ?? '127.0.0.1');
  if (hosts.length === 0) throw new Error('TTS_HOSTS is empty');
  for (const h of hosts) {
    if (!isIP(h)) throw new Error(`TTS_HOSTS must contain IP addresses only (got ${JSON.stringify(h)}; use 127.0.0.1 instead of localhost)`);
    // 全アドレスで待ち受けるアドレス。公開しないため起動時エラーにする
    if (isUnspecified(h)) throw new Error(`TTS_HOSTS must not contain ${h} (list each address to listen on)`);
  }

  const allowCidrs = list(env.TTS_ALLOW_CIDRS ?? '127.0.0.1/32,::1/128').map(c => {
    const parsed = parseCidr(c);
    if (!parsed) throw new Error(`TTS_ALLOW_CIDRS: invalid CIDR ${JSON.stringify(c)}`);
    return parsed;
  });
  for (const c of allowCidrs) {
    if (c.prefix === 0) warn(`warning: TTS_ALLOW_CIDRS contains /0 (${c.family === 4 ? '0.0.0.0/0' : '::/0'}), which allows every client address`);
  }

  const token = env.TTS_TOKEN ?? '';
  const adminToken = env.TTS_ADMIN_TOKEN ?? '';
  for (const [name, t] of [['TTS_TOKEN', token], ['TTS_ADMIN_TOKEN', adminToken]] as const) {
    if (!t) continue;
    if (t.startsWith(PLACEHOLDER_TOKEN)) throw new Error(`${name} is still the example value (${PLACEHOLDER_TOKEN}...); set a random value, e.g. openssl rand -hex 32`);
    if (t.length < MIN_TOKEN_CHARS) warn(`warning: ${name} is shorter than ${MIN_TOKEN_CHARS} characters`);
  }
  if (!token && !adminToken && hosts.some(h => !isLoopback(h))) {
    if (env.TTS_ALLOW_NO_TOKEN === '1') warn('warning: TTS_HOSTS has a non-loopback address but no token is set (TTS_ALLOW_NO_TOKEN=1); anyone allowed by TTS_ALLOW_CIDRS can use the API');
    else throw new Error('TTS_HOSTS has a non-loopback address, so set TTS_TOKEN and/or TTS_ADMIN_TOKEN (or TTS_ALLOW_NO_TOKEN=1 to run without authentication)');
  }

  const allowedHosts = list(env.TTS_ALLOWED_HOSTS ?? '').map(h => h.toLowerCase());

  const modelHosts = list(env.TTS_MODEL_HOSTS ?? 'tts-models.zenryoku.work,huggingface.co,hf.co').map(h => h.toLowerCase());

  return {
    hosts,
    port: int(env, 'TTS_PORT', 8710, 1, 65535),
    allowCidrs,
    allowedHosts,
    maxConnections: int(env, 'TTS_MAX_CONNECTIONS', 64, 1, 1024),
    token,
    adminToken,
    dataDir: resolve(env.TTS_DATA_DIR || join(dataHome, 'tts-gateway')),
    cacheDir: resolve(env.TTS_CACHE_DIR || join(cacheHome, 'tts-gateway', 'audio')),
    concurrency: int(env, 'TTS_CONCURRENCY', 1, 1, 2),
    queueMax: int(env, 'TTS_QUEUE_MAX', 8, 0, 1000),
    maxChars: int(env, 'TTS_MAX_CHARS', 2000, 1, 100_000),
    timeoutSec: int(env, 'TTS_TIMEOUT_SEC', 60, 1, 3600),
    modelHosts,
    modelMaxBytes: int(env, 'TTS_MODEL_MAX_MB', 512, 1, 100_000) * 1024 * 1024,
    ffmpeg: env.FFMPEG || 'ffmpeg',
    packageDir: PACKAGE_DIR,
  };
};
