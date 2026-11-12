/**
 * 登録モデルと状態（データディレクトリの models.json）。重みは models/<engine>/<id><ext>。
 *
 * - 進捗（progress）はメモリだけに持ち、状態が変わったときだけ書く
 * - 起動時に downloading / verifying のまま残っていたもの（途中で止まった）は error にする（取り直せる）
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../settings.ts';

export const MODEL_STATUSES = ['pending', 'downloading', 'verifying', 'installed', 'error'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export type ModelRecord = {
  engine: string;
  id: string;
  name: string;
  source: { url: string; sha256: string | null };
  status: ModelStatus;
  bytes: number | null;
  progress: { receivedBytes: number; totalBytes: number | null } | null;
  error: string | null;
  addedAt: string;
};

export const MODEL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** 登録できるモデルの数（全エンジンの合計） */
export const MAX_MODELS = 50;

export class Registry {
  readonly dataDir: string;
  private models: ModelRecord[];
  private writing: Promise<void> = Promise.resolve();

  private constructor(dataDir: string, models: ModelRecord[]) {
    this.dataDir = dataDir;
    this.models = models;
  }

  get path(): string {
    return join(this.dataDir, 'models.json');
  }

  /** ext はエンジンごとのモデルの拡張子（engine id → '.ztm'） */
  static async load(dataDir: string, extOf: (engine: string) => string | undefined): Promise<Registry> {
    let models: ModelRecord[] = [];
    try {
      models = (JSON.parse(await readFile(join(dataDir, 'models.json'), 'utf8')) as { models: ModelRecord[] }).models ?? [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const reg = new Registry(dataDir, models);
    let changed = false;
    for (const m of models) {
      m.progress = null;
      if (m.status === 'downloading' || m.status === 'verifying') {
        m.status = 'error';
        m.error = 'ダウンロードが中断されました（サーバーの停止）';
        changed = true;
      } else if (m.status === 'installed') {
        const ext = extOf(m.engine);
        if (ext && !existsSync(reg.modelPath(m.engine, m.id, ext))) {
          m.status = 'error';
          m.error = '重みのファイルがありません';
          changed = true;
        }
      }
    }
    if (changed) await reg.save();
    return reg;
  }

  modelPath(engine: string, id: string, ext: string): string {
    return join(this.dataDir, 'models', engine, `${id}${ext}`);
  }

  list(engine?: string): ModelRecord[] {
    return this.models.filter(m => !engine || m.engine === engine);
  }

  get(engine: string, id: string): ModelRecord | undefined {
    return this.models.find(m => m.engine === engine && m.id === id);
  }

  async add(m: ModelRecord): Promise<void> {
    this.models.push(m);
    await this.save();
  }

  /** 状態を変える。persist: false は進捗だけの更新（書かない） */
  async update(engine: string, id: string, patch: Partial<ModelRecord>, persist = true): Promise<ModelRecord | undefined> {
    const m = this.get(engine, id);
    if (!m) return undefined;
    Object.assign(m, patch);
    if (persist) await this.save();
    return m;
  }

  async remove(engine: string, id: string): Promise<void> {
    this.models = this.models.filter(m => !(m.engine === engine && m.id === id));
    await this.save();
  }

  private save(): Promise<void> {
    const body = `${JSON.stringify({ models: this.models.map(m => ({ ...m, progress: null })) }, null, 2)}\n`;
    this.writing = this.writing.catch(() => {}).then(() => writeAtomic(this.path, body));
    return this.writing;
  }
}
