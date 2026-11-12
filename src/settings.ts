/**
 * 画面から変えられる設定（データディレクトリの settings.json）。書き込みは .tmp → fsync → rename で原子的に。
 * PUT /v1/admin/settings は部分更新（送ったキーだけ変える。defaultVoices は送ったエンジンの分だけ変える）。
 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { invalid, notFound } from './errors.ts';

export type Settings = {
  defaultEngine: string;
  defaultVoices: Record<string, string>;
  /** 0 は解放しない */
  idleUnloadSec: number;
  /** 0 はキャッシュ無効 */
  cacheMaxMB: number;
  cacheTtlDays: number;
};

export const DEFAULT_SETTINGS: Settings = {
  defaultEngine: 'zen-tts',
  defaultVoices: { 'zen-tts': 'marine' },
  idleUnloadSec: 600,
  cacheMaxMB: 500,
  cacheTtlDays: 30,
};

/** path.tmp に書いて fsync してから rename し、親ディレクトリも fsync する（親の fsync の失敗は無視） */
export const writeAtomic = async (path: string, body: string): Promise<void> => {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  try {
    const dh = await open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // ディレクトリの fsync ができない環境もある
  }
};

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export type SettingsContext = {
  engineIds: readonly string[];
  isInstalled: (engine: string, voice: string) => boolean;
};

/** PUT の本文を検査する。未知のキー・範囲外は 400 */
export const validateSettingsPatch = (raw: unknown, ctx: SettingsContext): Partial<Settings> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('body must be a JSON object');
  const body = raw as Record<string, unknown>;
  const out: Partial<Settings> = {};
  for (const [key, v] of Object.entries(body)) {
    switch (key) {
      case 'defaultEngine':
        if (typeof v !== 'string') throw invalid('defaultEngine must be a string', key);
        if (!ctx.engineIds.includes(v)) throw notFound(`engine ${v} not found`, key);
        out.defaultEngine = v;
        break;
      case 'defaultVoices': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('defaultVoices must be an object', key);
        const voices: Record<string, string> = {};
        for (const [engine, voice] of Object.entries(v as Record<string, unknown>)) {
          const field = `defaultVoices.${engine}`;
          if (!ctx.engineIds.includes(engine)) throw invalid(`engine ${engine} not found`, field);
          if (typeof voice !== 'string') throw invalid(`${field} must be a string`, field);
          if (!ctx.isInstalled(engine, voice)) throw invalid(`voice ${voice} of ${engine} is not installed`, field);
          voices[engine] = voice;
        }
        out.defaultVoices = voices;
        break;
      }
      case 'idleUnloadSec':
        if (!isInt(v) || !(v === 0 || (v >= 60 && v <= 86400)))
          throw invalid('idleUnloadSec must be 0 or an integer between 60 and 86400', key);
        out.idleUnloadSec = v;
        break;
      case 'cacheMaxMB':
        if (!isInt(v) || v < 0 || v > 10000) throw invalid('cacheMaxMB must be an integer between 0 and 10000', key);
        out.cacheMaxMB = v;
        break;
      case 'cacheTtlDays':
        if (!isInt(v) || v < 1 || v > 365) throw invalid('cacheTtlDays must be an integer between 1 and 365', key);
        out.cacheTtlDays = v;
        break;
      default:
        throw invalid(`unknown field ${key}`, key);
    }
  }
  return out;
};

export class SettingsStore {
  private value: Settings;
  private readonly path: string;
  private writing: Promise<void> = Promise.resolve();
  private readonly listeners: ((s: Settings) => void)[] = [];

  private constructor(path: string, value: Settings) {
    this.path = path;
    this.value = value;
  }

  static async load(dataDir: string): Promise<SettingsStore> {
    const path = join(dataDir, 'settings.json');
    let saved: Partial<Settings> = {};
    try {
      saved = JSON.parse(await readFile(path, 'utf8')) as Partial<Settings>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const value: Settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      defaultVoices: { ...DEFAULT_SETTINGS.defaultVoices, ...saved.defaultVoices },
    };
    return new SettingsStore(path, value);
  }

  get(): Settings {
    return this.value;
  }

  onChange(fn: (s: Settings) => void): void {
    this.listeners.push(fn);
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.value = {
      ...this.value,
      ...patch,
      defaultVoices: { ...this.value.defaultVoices, ...patch.defaultVoices },
    };
    const body = `${JSON.stringify(this.value, null, 2)}\n`;
    this.writing = this.writing.catch(() => {}).then(() => writeAtomic(this.path, body));
    await this.writing;
    for (const fn of this.listeners) fn(this.value);
    return this.value;
  }
}
