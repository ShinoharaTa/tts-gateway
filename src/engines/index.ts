/**
 * エンジンの登録表。エンジンを足すときはここに 1 行足す（固有オプションのキーは Engine.optionsKey）。
 */
import type { Registry } from '../models/registry.ts';
import type { Settings } from '../settings.ts';
import type { Engine } from './types.ts';
import { ZenTtsEngine } from './zen-tts/engine.ts';

export type EngineDeps = { registry: Registry; settings: () => Settings; concurrency: number };

export const createEngines = (deps: EngineDeps): Map<string, Engine> => {
  const engines: Engine[] = [new ZenTtsEngine({ registry: deps.registry, settings: deps.settings, poolSize: deps.concurrency })];
  return new Map(engines.map(e => [e.id, e]));
};

/** モデルの拡張子（engine id → '.ztm'）。registry の読み込みに使う */
export const MODEL_EXTS: Record<string, string> = { 'zen-tts': '.ztm' };
