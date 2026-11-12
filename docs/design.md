# tts-gateway 内部設計

API の外形は [api.md](api.md)。ここは実装の構成と決めごと。

## 実行環境

- Node.js **26.12.1 以上**（zen-tts の要件）。TypeScript は Node の type stripping で直接実行（ビルド無し）。
  型注釈は erasable なものだけ（`enum`・`namespace`・パラメータプロパティを使わない）。import は `.ts` 拡張子付き。
- 依存は `zen-tts`（`github:zenryokukikai/zen-tts#v1.3.0`）だけ。HTTP は `node:http`、テストは `node --test`。
- 圧縮形式（mp3 / opus / m4a / flac）とリサンプルは `ffmpeg`（`FFMPEG` 環境変数、既定は PATH の `ffmpeg`）。
  `wav` で `sampleRate` がエンジンの値と同じなら ffmpeg を使わない。

## ディレクトリ

```
src/
  cli.ts              # `serve` / `models fetch [id...]` / `models list`
  config.ts           # 環境変数 → Config（既定値・検証）
  server.ts           # node:http。ルーティング、認証、接続元の許可リスト、静的ファイル（public/）
  net.ts              # CIDR 判定、複数ホストへの listen（EADDRNOTAVAIL は 5 秒ごとに再試行）
  errors.ts           # ApiError(status, code, message, field?)
  validate.ts         # リクエストの検証（未知フィールドは 400）
  synthesize.ts       # 前処理 → 辞書 → 文分割 → エンジン → 無音処理・連結 → エンコード
  text/spoken.ts      # 記号の読み替え（signal-digest-tts の spoken.ts と同じ規則）
  text/readings.ts    # 読み辞書（signal-digest-tts の readings.ts の compile/apply/hits/unknownWords と同じ規則。DB 部分は無し）
  audio/pcm.ts        # trimSilence・無音・音量・連結・WAV 書き出し
  audio/encode.ts     # ffmpeg で各形式へ
  queue.ts            # 同時実行数・待ち行列上限・同一キーの合流
  cache.ts            # ディスクキャッシュ（キー→ファイル + メタ JSON、LRU・TTL）
  settings.ts         # データディレクトリの settings.json（原子的書き込み）
  models/registry.ts  # models.json（登録モデルと状態）
  models/download.ts  # https 取得、ホスト許可、上限、sha256、.part → rename、進捗
  models/catalog.ts   # catalog/*.json を読む
  engines/types.ts    # Engine インターフェース
  engines/index.ts    # エンジンの登録表
  engines/zen-tts/engine.ts  # Engine 実装（子プロセスの管理、アイドル解放、声の切り替え）
  engines/zen-tts/child.ts   # 子プロセス。ZenTtsNode を読み込み、文を合成して PCM を返す
public/admin/         # 設定画面（素の HTML/CSS/JS、日本語、スマホ幅で使える）
catalog/zen-tts.json  # 公式の 4 声（URL・sha256・名前）
dict/readings.tsv     # 組み込みの読み辞書
deploy/systemd/tts-gateway.service
test/*.test.ts
```

## データの置き場所（リポジトリの外）

| 環境変数 | 既定 | 中身 |
|---|---|---|
| `TTS_DATA_DIR` | `$XDG_DATA_HOME/tts-gateway`（`~/.local/share/tts-gateway`） | `settings.json`、`models.json`、`models/<engine>/<id>.<ext>`、`readings.tsv`（ユーザー辞書） |
| `TTS_CACHE_DIR` | `$XDG_CACHE_HOME/tts-gateway/audio` | 音声キャッシュ |

## Engine インターフェース

```ts
interface Engine {
  id: string; name: string; version: string; sampleRate: number;
  credit: { ja: string; en: string; url: string };
  modelExt: string;                        // '.ztm'
  optionsKey: string;                      // リクエストの固有オプションのキー（'zenTts'）
  voices(): VoiceInfo[];                   // registry のインストール済みモデルから
  validateOptions(raw: unknown): EngineOptions;   // 範囲外・未知は ApiError 400
  verifyModel(path: string): Promise<{ voiceId: string }>;  // 取得後の検査
  synthesize(sentence: string, voice: ModelRecord, opts: EngineOptions, signal: AbortSignal, slot: number): Promise<Float32Array>;  // slot: 待ち行列のスロット
  status(): EngineStatus;
  close(): Promise<void>;
}
```

将来の VOICEVOX は、VOICEVOX Engine（別プロセスの HTTP）を叩く adapter として `engines/voicevox/` に足す。
固有オプションは `voicevox` キー。モデル管理をしないエンジンは `voices()` を自分で返す。

## ZEN-TTS エンジン

- 合成は `child_process.fork`（`serialization: 'advanced'` で Float32Array を受け渡す）。worker_threads では解放しても RSS が戻らないため。
- 子プロセスは待ち行列のスロット（`TTS_CONCURRENCY` 個）ごとに 1 つで、それぞれ 1 つの声だけ読む。
  そのスロットに別の声が来たら、今の合成が終わってからその子を終了して起動し直す（起動は同時に 1 つずつ）。
- どのスロットにどの要求を流すかは `queue.ts` が決める。スロットは最後に流した声を覚え、空いたら待ち行列から次の順で 1 件取る
  （`TTS_CONCURRENCY=1` は FIFO のまま）:
  1. 先頭の要求が待ち行列に入ってから 15 秒（`PRIORITY_AFTER_MS`）以上たっていれば先頭
  2. 最初に追い越されてから `TTS_AFFINITY_MAX_WAIT_MS`（既定 5000）以上たった最も古い要求（追い越され続けないため）
  3. このスロットの声と同じ声の最も古い要求
  4. 他のスロットが読み込んでいない声の最も古い要求
  5. 先頭
  取った要求より前にあった要求は「追い越された」とし、最初に追い越された時刻を覚える（時刻は `performance.now()`）。
  空きが 2 つあるときは、取る要求の声を読み込んでいるスロットに流す。スロットには `Engine.synthesize` の `slot` で渡す。
- スロットごとに、`idleUnloadSec` 使われなければその子を終了。読み込み中に `stop()` で止めた子の終了は、他のスロットの待ちを失敗させない。子が落ちたら合成中の要求は 503、次の要求で起動し直す。
- 1 文ごとに `speak()`（`speakStream` は使わない。文分割は共通層）。1 文の合成 30 秒、要求全体 `TTS_TIMEOUT_SEC`（既定 60）でタイムアウト。
- 1 回の合成の上限（256 字・512 音素・2048 フレーム）を超えた文（`own tts: … (max …)`）は、子を落とさず `SentenceTooLongError` にする。
  共通層がその文を中央に最も近い読点・空白・中黒（無ければ中央）で半分に割って合成し直し、無音を挟まずにつなぐ（最大 4 段）。
  それでも超えるか 1 文字まで割っても超えるなら 422 `unprocessable_text`。数字の長い並びや `zenTts.accentDict` で読みが長くなった文も同じ。
- `ZenTtsNode.load({ model })`: `modelsPath` は渡さない（G2P はパッケージ同梱）。

## 設定画面（/admin/）

- 1 ページ。上から「状態」「試聴」「モデル」「読み辞書」「設定」「クレジット」。
- モデル: 一覧（状態・サイズ・進捗バー）、カタログから追加（選ぶだけ）、URL で追加（id・名前・URL・sha256 任意）、取り直し、削除。
  ダウンロード中は 1 秒ごとに `GET /v1/admin/models` を見る。
- 試聴: テキスト・声・速さ・高さ・感情・形式 → `/v1/synthesize` → `<audio>` で再生、ダウンロードリンク。`/v1/normalize` の結果（読み・未知語）も出す。未知語は 1 タップで辞書の追加欄に入る。
- `TTS_ADMIN_TOKEN` / `TTS_TOKEN` があるときは画面でトークンを入力し、`localStorage` に保存して `Authorization` に付ける。
- 外部 CDN を使わない（全部 public/ に置く）。

## systemd（--user、有効化はユーザーの確認後）

`Nice=10` `CPUQuota=150%` `MemoryHigh=600M` `MemoryMax=800M`、`EnvironmentFile=%h/.config/tts-gateway/env`（ホスト・許可 CIDR・トークン。リポジトリに入れない）。
