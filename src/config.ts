/**
 * 環境変数 → Config。既定値と検証はここだけで持つ（README「環境変数」）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCidr, type Cidr } from './net.ts';

/** リポジトリのルート（dict/・catalog/・public/ の場所） */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION: string = (JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }).version;

export type Config = {
  hosts: string[];
  port: number;
  allowCidrs: Cidr[];
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

/** 全アドレスで待ち受けるアドレス。公開しないため起動時エラーにする */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0']);

export const loadConfig = (env: Env = process.env): Config => {
  const home = env.HOME || homedir();
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const cacheHome = env.XDG_CACHE_HOME || join(home, '.cache');

  const hosts = list(env.TTS_HOSTS ?? '127.0.0.1');
  if (hosts.length === 0) throw new Error('TTS_HOSTS is empty');
  for (const h of hosts) {
    if (WILDCARD_HOSTS.has(h)) throw new Error(`TTS_HOSTS must not contain ${h} (list each address to listen on)`);
  }

  const allowCidrs = list(env.TTS_ALLOW_CIDRS ?? '127.0.0.1/32,::1/128').map(c => {
    const parsed = parseCidr(c);
    if (!parsed) throw new Error(`TTS_ALLOW_CIDRS: invalid CIDR ${JSON.stringify(c)}`);
    return parsed;
  });

  const modelHosts = list(env.TTS_MODEL_HOSTS ?? 'tts-models.zenryoku.work,huggingface.co,hf.co').map(h => h.toLowerCase());

  return {
    hosts,
    port: int(env, 'TTS_PORT', 8710, 1, 65535),
    allowCidrs,
    token: env.TTS_TOKEN ?? '',
    adminToken: env.TTS_ADMIN_TOKEN ?? '',
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
