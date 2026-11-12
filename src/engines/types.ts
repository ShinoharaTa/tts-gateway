/**
 * エンジンの共通インターフェース（docs/design.md「Engine インターフェース」）。
 * 文分割・無音・連結・エンコードは共通層（synthesize.ts）で、エンジンは 1 文を PCM にするだけ。
 */
import type { ModelRecord } from '../models/registry.ts';

export type Credit = { ja: string; en: string; url: string };

export type VoiceInfo = { id: string; name: string; installed: boolean; default: boolean };

/** validateOptions が返す、そのエンジンの固有オプション（キャッシュキーにも入る） */
export type EngineOptions = Record<string, unknown>;

export type EngineStatus = {
  id: string;
  /** 読み込み中の声（無ければ null） */
  loaded: string | null;
  kernel: string | null;
  process: { pid: number; rssBytes: number | null } | null;
  idleUnloadSec: number;
};

export interface Engine {
  id: string;
  name: string;
  version: string;
  sampleRate: number;
  credit: Credit;
  /** モデルファイルの拡張子（'.ztm'） */
  modelExt: string;
  /** リクエストの固有オプションのキー（'zenTts'） */
  optionsKey: string;
  /** GET /v1/engines の options・emotions・curves など（エンジンごとの追加の項目） */
  describe(): Record<string, unknown>;
  /** registry の登録済みモデルから（installed はインストール済みか） */
  voices(): VoiceInfo[];
  /** 範囲外・未知は ApiError 400 */
  validateOptions(raw: unknown): EngineOptions;
  /** 1 文の最大字数の上限（オプションで 1 回の合成の長さが変わるエンジン用。省略時は制限なし） */
  sentenceCharLimit?(opts: EngineOptions): number;
  /** 取得後の検査。読めなければ例外 */
  verifyModel(path: string): Promise<{ voiceId: string }>;
  /** 1 文を合成する（sampleRate のモノラル float32） */
  synthesize(sentence: string, voice: ModelRecord, opts: EngineOptions, signal: AbortSignal): Promise<Float32Array>;
  status(): EngineStatus;
  close(): Promise<void>;
}
