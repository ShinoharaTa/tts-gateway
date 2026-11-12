/**
 * 追加できる公式モデルの一覧（リポジトリの catalog/*.json）。
 * 形式: { "engine": "zen-tts", "models": [{ "id", "name", "url", "sha256", "bytes" }] }
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type CatalogModel = { engine: string; id: string; name: string; url: string; sha256: string; bytes: number };

export const loadCatalog = (dir: string): CatalogModel[] => {
  const out: CatalogModel[] = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    const file = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { engine: string; models: Omit<CatalogModel, 'engine'>[] };
    for (const m of file.models) out.push({ engine: file.engine, id: m.id, name: m.name, url: m.url, sha256: m.sha256, bytes: m.bytes });
  }
  return out;
};
