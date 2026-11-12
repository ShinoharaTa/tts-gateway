# tts-gateway API 仕様 v1

機械可読な仕様は [`openapi.yaml`](../openapi.yaml)（OpenAPI 3.1）。両者の内容は一致させる（食い違いはバグ）。

- ベース URL: `http://<host>:<port>`（既定ポート 8710）
- 文字コード: UTF-8。リクエスト本文は `Content-Type: application/json` のみ受け付ける（それ以外は 415）。
- 認証: 環境変数 `TTS_TOKEN` を設定したときだけ、`/healthz` と設定画面の静的ファイル（`/admin/`。画面で入力したトークンを API の呼び出しに付ける）以外で `Authorization: Bearer <TTS_TOKEN>` が必須。
  `/v1/admin/*` は `TTS_ADMIN_TOKEN` を設定したときだけ、その値が必須（未設定なら `TTS_TOKEN` の規則に従う）。
- 接続元: `TTS_ALLOW_CIDRS` に入らない接続元は 403（`forbidden`）。
- CORS ヘッダは返さない（別オリジンのブラウザからは呼べない。JSON 必須と合わせて CSRF 対策）。

## エラー形式

```json
{ "error": { "code": "invalid_request", "message": "speed must be between 0.5 and 1.5", "field": "speed" } }
```

| HTTP | code | 意味 |
|---|---|---|
| 400 | `invalid_request` | パラメータ不正（範囲外・型違い・未知のフィールド・そのエンジンが対応しないオプション） |
| 401 | `unauthorized` | トークンが無い・違う |
| 403 | `forbidden` | 接続元が許可リスト外 |
| 404 | `not_found` | エンジン・声・モデル・パスが無い |
| 409 | `conflict` | 同じ id のモデルがある・ダウンロード中 など |
| 413 | `text_too_long` | `text` が上限（既定 2,000 字）を超えた |
| 415 | `unsupported_media_type` | JSON 以外の本文 |
| 422 | `model_not_installed` | 声は登録済みだが重みが未取得 |
| 429 | `queue_full` | 待ち行列が満杯。`Retry-After` ヘッダ（秒）付き |
| 500 | `internal_error` | 想定外の失敗 |
| 503 | `engine_unavailable` | モデル読み込み・合成プロセスの失敗 |
| 504 | `timeout` | 合成が時間内（既定 60 秒）に終わらなかった |

**未知のフィールドは 400**（打ち間違いを黙って無視しない）。

---

## GET /healthz

モデルを読まずに返す。認証不要。

```json
{ "status": "ok", "version": "0.1.0" }
```

## GET /v1/engines

エンジン・声・対応オプションの一覧。

```json
{
  "default": { "engine": "zen-tts", "voice": "marine" },
  "engines": [
    {
      "id": "zen-tts",
      "name": "ZEN-TTS",
      "version": "1.3.0",
      "credit": { "ja": "音声合成：ZEN-TTS（https://zenryokukikai.com）", "en": "Speech synthesis: ZEN-TTS (https://zenryokukikai.com)", "url": "https://zenryokukikai.com" },
      "sampleRate": 44100,
      "voices": [
        { "id": "marine", "name": "全力 マリン", "installed": true, "default": true }
      ],
      "options": ["emotion", "change", "strength", "speed", "pitch", "latin", "numbers", "accentDict", "accentSettings"],
      "emotions": ["neutral", "happy", "sad", "angry", "apologetic"],
      "curves": ["ease", "linear", "fast-start", "late-surge", "switch", "steps", "hill", "valley", "wave"]
    }
  ]
}
```

## POST /v1/synthesize

テキストを音声にする。成功時の本文は音声バイナリ。

### リクエスト

| フィールド | 型 | 既定 | 説明 |
|---|---|---|---|
| `text` | string | （必須） | 読む文章。1〜2,000 字（`TTS_MAX_CHARS`）。改行・「。！？」で文に分けて順に合成する |
| `engine` | string | 設定の既定 | `GET /v1/engines` の `id` |
| `voice` | string | エンジンの既定 | `voices[].id` |
| `format` | string | `wav` | `wav`（16bit PCM）/ `mp3` / `opus`（Ogg）/ `m4a`（AAC）/ `flac` |
| `sampleRate` | integer | エンジンの値 | 出力のサンプルレート。`8000` `16000` `22050` `24000` `44100` `48000` のいずれか。`opus` は Opus が扱えない `22050`・`44100` を `48000` で書く（`X-Sample-Rate` は実際の値） |
| `bitrate` | string | `mp3`:`128k` `opus`:`48k` `m4a`:`64k` | 圧縮形式のビットレート（`16k`〜`320k`）。`wav`・`flac` では指定すると 400 |
| `volume` | number | `0` | 音量の増減（dB、`-20`〜`+12`）。クリップしないよう ±1 に丸める |
| `sentencePauseMs` | integer | `250` | 文と文の間の無音（ms、`0`〜`3000`） |
| `leadingSilenceMs` | integer | `0` | 先頭に足す無音（ms、`0`〜`3000`） |
| `trailingSilenceMs` | integer | `0` | 末尾に足す無音（ms、`0`〜`3000`） |
| `trimSilence` | boolean | `true` | 各文の前後の無音を詰めてから `sentencePauseMs` を入れる |
| `maxSentenceChars` | integer | `120` | 1 文の最大字数（`20`〜`120`）。超える文は読点・空白で分ける。ZEN-TTS で `speed` < 1 のときは `120 × speed` 字が上限になる |
| `preprocess` | boolean | `true` | 記号の読み替え（URL 削除、`%`→パーセント、`$20`→20ドル、`→`→から 等） |
| `dictionary` | boolean | `true` | 読み辞書（英字 → カタカナ）を通す |
| `readings` | object | `{}` | この要求だけの読み辞書の追加・上書き。`{ "Foo": "フー" }`。最大 200 語。読みはカタカナ |
| `cache` | boolean | `true` | `false` でキャッシュを読まず書かない |
| `zenTts` | object | — | ZEN-TTS 固有のオプション（下表）。`engine` が `zen-tts` 以外なら 400 |

`zenTts` オブジェクト（ZEN-TTS 1.3.0 の `speak()` のオプションをすべて受ける）:

| フィールド | 型 | 既定 | 説明 |
|---|---|---|---|
| `emotion` | object | neutral | 感情の比率。`{ "happy": 70, "neutral": 30 }`。キーは `neutral` `happy` `sad` `angry` `apologetic`、値は 0 以上（比だけが効く） |
| `change` | object | — | 文の途中で感情を変える。`{ "to": {…感情…}, "curve": "ease", "from": 0.2, "until": 0.8 }`。`from`・`until` は 0〜1（`from` < `until`） |
| `strength` | number | `1` | 抑揚の強さ（`0`〜`2`） |
| `speed` | number | `1` | 話す速さ（`0.5`〜`1.5`） |
| `pitch` | number | `0` | 声の高さ（半音、`-6`〜`+12`） |
| `latin` | boolean | `true` | ローマ字・短い略語を規則で読む（`SDK` → エスディーケー） |
| `numbers` | string | `rule` | 長い金額・単位の前の 5 けた以上の数字を `rule`（規則）か `model`（読みのモデル）で読む |
| `accentDict` | array | `[]` | ZEN-TTS の読み・アクセント辞書（最大 100 件）。要素 `{ surface, reading, accent?, phrase?, strength?, contour?, pitch?, length?, note? }`（ZEN-TTS README「辞書の形式」と同じ） |
| `accentSettings` | object | — | `{ "accentHeight": number, "pitchRange"?: number[5] }` |

`change`・`emotion` は文ごとに同じ値を使う（文章全体ではなく 1 文の中で変化する）。

例:

```bash
curl -sS -X POST http://127.0.0.1:8710/v1/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"GitHub に Claude のコードを push しました。","voice":"marine","format":"mp3","zenTts":{"speed":1.1,"emotion":{"happy":60,"neutral":40}}}' \
  -o out.mp3
```

### レスポンス

- `200`、本文は音声。`Content-Type`: `audio/wav` / `audio/mpeg` / `audio/ogg` / `audio/mp4` / `audio/flac`
- ヘッダ:

| ヘッダ | 例 | 説明 |
|---|---|---|
| `X-Engine` | `zen-tts` | 使ったエンジン |
| `X-Voice` | `marine` | 使った声 |
| `X-Audio-Duration-Ms` | `3120` | 音声の長さ |
| `X-Sample-Rate` | `44100` | 出力のサンプルレート |
| `X-Cache` | `hit` / `miss` / `bypass` | キャッシュ |
| `X-Synthesis-Ms` | `410` | 合成にかかった時間（`hit` なら 0） |
| `X-TTS-Credit` | `Speech%20synthesis%3A%20ZEN-TTS%20(https%3A%2F%2Fzenryokukikai.com)` | 帰属表示（URL エンコード）。**この音声を使う側でも表示が必要** |
| `ETag` | `"<cache key>"` | キャッシュキー |

## POST /v1/normalize

合成せずに、前処理と読み辞書を通した後の文を返す。リクエストは `/v1/synthesize` と同じ（音声関係のフィールドは無視せず検証だけする）。

```json
{
  "text": "GitHub に Claude のコードを push しました。",
  "spoken": "ギットハブ に クロード のコードを プッシュ しました。",
  "sentences": ["ギットハブ に クロード のコードを プッシュ しました。"],
  "hits": [{ "surface": "github", "reading": "ギットハブ" }, { "surface": "claude", "reading": "クロード" }, { "surface": "push", "reading": "プッシュ" }],
  "unknownWords": []
}
```

`unknownWords`: 辞書に無い、小文字を含む英単語（`[{ "word": "foo", "count": 1 }]`）。辞書に足す候補。

## GET /v1/dictionary

読み辞書（組み込み + ユーザー追加）。

```json
{
  "version": "<sha256>",
  "entries": [{ "surface": "GitHub", "reading": "ギットハブ", "source": "builtin" }, { "surface": "Foo", "reading": "フー", "source": "user" }]
}
```

`source`: `builtin`（`dict/readings.tsv`、リポジトリ）/ `user`（データディレクトリの `readings.tsv`）。同じ語なら `user` が優先。

---

## 管理 API（/v1/admin/*）

設定画面（`GET /admin/`）が使う。

### GET /v1/admin/status

```json
{
  "version": "0.1.0",
  "uptimeSec": 120,
  "engines": [{
    "id": "zen-tts", "loaded": "marine", "kernel": "wasm", "process": { "pid": 1234, "rssBytes": 300000000 },
    "processes": [
      { "slot": 0, "voice": "marine", "pid": 1234, "state": "idle", "rssBytes": 300000000 },
      { "slot": 1, "voice": "kai", "pid": 1240, "state": "busy", "rssBytes": 310000000 }
    ],
    "idleUnloadSec": 600
  }],
  "queue": { "running": 1, "waiting": 0, "max": 8, "concurrency": 2 },
  "cache": { "entries": 12, "bytes": 1048576, "maxBytes": 524288000 },
  "memory": { "rssBytes": 80000000 }
}
```

`loaded`・`kernel`・`process` は合成プロセス 1 つ分（互換のため残している）。`processes` はスロット（`TTS_CONCURRENCY` 個）ごとの合成プロセスで、
`state` は `starting`（声の読み込み中）・`idle`・`busy`（合成中）。`rssBytes` は取れなければ `null`。プロセスの無いスロットは載らない。

### GET /v1/admin/settings / PUT /v1/admin/settings

画面から変えられる設定。`PUT` は部分更新（送ったキーだけ変える）で、更新後の全体を返す。

```json
{
  "defaultEngine": "zen-tts",
  "defaultVoices": { "zen-tts": "marine" },
  "idleUnloadSec": 600,
  "cacheMaxMB": 500,
  "cacheTtlDays": 30
}
```

範囲: `idleUnloadSec` 0（解放しない）または 60〜86400、`cacheMaxMB` 0（キャッシュ無効）〜10000、`cacheTtlDays` 1〜365。
`defaultVoices` の声はインストール済みであること（でなければ 400）。

### GET /v1/admin/catalog

追加できる公式モデルの一覧（リポジトリの `catalog/*.json`）。

```json
{ "models": [{ "engine": "zen-tts", "id": "kikka", "name": "全力 キッカ", "url": "https://tts-models.zenryoku.work/v1.3.0/kikka.ztm", "sha256": "81f3…", "bytes": 27700000, "registered": false }] }
```

### GET /v1/admin/models

登録済みモデルと状態。

```json
{
  "models": [
    {
      "engine": "zen-tts", "id": "marine", "name": "全力 マリン",
      "source": { "url": "https://tts-models.zenryoku.work/v1.3.0/marine.ztm", "sha256": "c7bd…" },
      "status": "installed",
      "bytes": 27700000,
      "progress": null,
      "error": null,
      "addedAt": "2026-11-12T00:00:00Z"
    }
  ]
}
```

`status`: `pending`（未取得）/ `downloading`（`progress`: `{ "receivedBytes", "totalBytes" | null }`）/ `verifying` / `installed` / `error`（`error` に理由）。

### POST /v1/admin/models

モデルを登録し、ダウンロードを始める（非同期。`202` を返し、状態は `GET /v1/admin/models` で見る）。

```json
{ "engine": "zen-tts", "id": "kikka", "name": "全力 キッカ", "url": "https://tts-models.zenryoku.work/v1.3.0/kikka.ztm", "sha256": "81f3…" }
```

- `catalog: "kikka"` だけを送るとカタログの値で登録する（`{ "engine": "zen-tts", "catalog": "kikka" }`）。
- `id`: `^[a-z0-9][a-z0-9_-]{0,31}$`。同じエンジンに同じ id があれば 409。
- `url`: `https://` のみ。ホストは `TTS_MODEL_HOSTS`（既定 `tts-models.zenryoku.work,huggingface.co,hf.co`）のどれか、またはそのサブドメインであること。リダイレクト先も同じ規則で検査する。上限 `TTS_MODEL_MAX_MB`（既定 512MB）。
- `sha256`: 任意。指定したら一致しないと `error`。省略したら取得したファイルの値を記録する（以後の再取得はその値で検査する）。
- 取得後、エンジンで読み込めるか検査する（ZEN-TTS: `.ztm` のヘッダと読み込み）。失敗なら `error` にしてファイルを消す。

### POST /v1/admin/models/{engine}/{id}/download

`pending` / `error` のモデルを取り直す。`202`。

### DELETE /v1/admin/models/{engine}/{id}

登録と重みのファイルを消す。既定の声に設定されているものは 409。ダウンロード中なら中止して消す。`204`。

### PUT /v1/admin/dictionary/{surface} / DELETE /v1/admin/dictionary/{surface}

ユーザー辞書の語を追加・更新（本文 `{ "reading": "フー" }`）・削除。`surface` は URL エンコード。
組み込み辞書の語を `PUT` すると、ユーザー辞書の値で上書きされる（組み込みの TSV は変えない）。
`DELETE` で消せるのはユーザー辞書の語だけ（組み込みは 404）。返り値は `GET /v1/dictionary` と同じ形。

### DELETE /v1/admin/cache

音声キャッシュを全部消す。`204`。

---

## 読み辞書の規則

- 照合は NFKC + 大文字小文字を同一視。長い語から当てる（`MacBook Pro` が `MacBook` より先）。
- 語の境界: 前が英数字でない、後ろが英字でない（`iPhone16` → アイフォーン16）。
- 置き換えない: URL・メールアドレス・ドメイン（`example.com`）の中、**全部大文字で 5 字以内の語**（`API` `GPU`。ZEN-TTS の略語規則に任せる）。
- 語の直後の所有格 `'s` は消し、`-数字`・`-英字` のハイフンは空白にする（`Pixel-9` → ピクセル 9）。
- 読みは全角カタカナ・長音符・中黒・空白だけ。

## キャッシュ

キーは sha256(エンジン id・版、声 id とモデルの sha256、前処理・辞書を通した後の文、音声に効くすべてのパラメータ、出力形式)。
辞書を変えても、その文の読みが変わらなければヒットする。保存先 `TTS_CACHE_DIR`（既定 `~/.cache/tts-gateway/audio`）。
`cacheMaxMB` を超えたら最終アクセスの古い順に消す。`cacheTtlDays` を過ぎたものも消す。

## 同時実行

- 合成は `TTS_CONCURRENCY`（既定 1、最大 2）本ずつ。待ち行列は `TTS_QUEUE_MAX`（既定 8）件まで、超えたら 429。
- 同じキャッシュキーの要求が合成中なら、新たに合成せずその結果を待つ。
- モデルは最初の要求で読み込み（数秒）、`idleUnloadSec` 使われなければ合成プロセスごと終了してメモリを返す（スロットごとに数える）。
- 合成プロセスは同時実行の枠（スロット）ごとに 1 つで、それぞれ 1 つの声を読む。別の声の要求がそのスロットに来たら、そのプロセスだけ読み直す。
- `TTS_CONCURRENCY=1` の待ち行列は FIFO。`2` では、空いたスロットが次の順で 1 件取る（声の読み直しを減らす）:
  1. 待ち行列の先頭（最も古い）の要求が、待ち行列に入ってから 15 秒以上たっていれば、それ（声が違えば読み直す）
  2. 最初に追い越されてから `TTS_AFFINITY_MAX_WAIT_MS`（既定 5000）ミリ秒以上たった要求のうち最も古いもの（声が違えば読み直す）
  3. このスロットの声と同じ声の要求のうち最も古いもの
  4. 他のスロットが読み込んでいない声の要求のうち最も古いもの
  5. 先頭の要求

  そのため `2` では、要求が届いた順に始まるとは限らない（追い越され始めてから最長でおよそ `TTS_AFFINITY_MAX_WAIT_MS`、
  待ち行列に入ってから最長でおよそ 15 秒と、そのとき合成中の要求が終わるまで）。
