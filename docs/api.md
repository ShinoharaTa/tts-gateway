# tts-gateway API 仕様 v1

機械可読な仕様は [`openapi.yaml`](../openapi.yaml)（OpenAPI 3.1）。両者の内容は一致させる（食い違いはバグ）。

- ベース URL: `http://<host>:<port>`（既定ポート 8710）
- 文字コード: UTF-8。リクエスト本文は `Content-Type: application/json` のみ受け付ける（それ以外は 415）。JSON を受ける `POST` / `PUT` は本文が空でも `Content-Type` が違えば 415。本文の上限は 1MB（超えたら 400）。
- 認証: 環境変数 `TTS_TOKEN` を設定したときだけ、`/healthz` と設定画面の静的ファイル（`/admin/`。画面で入力したトークンを API の呼び出しに付ける）以外で `Authorization: Bearer <TTS_TOKEN>` が必須。`TTS_ADMIN_TOKEN` でも通る。
  `/v1/admin/*` は `TTS_ADMIN_TOKEN` を設定したときだけ、その値が必須（未設定なら `TTS_TOKEN` の規則に従う）。
  認証はパスの有無より先に行う（トークンが要る構成では、未定義のパス・未対応のメソッドも未認証なら 401）。
- 接続元: `TTS_ALLOW_CIDRS` に入らない接続元は 403（`forbidden`）。
- Host: `Host` ヘッダが `TTS_HOSTS` の各アドレス:`TTS_PORT`（IPv6 は `[::1]:8710` の形。ポート 80 ならポート無しも可）、`127.0.0.1`・`::1` で待ち受けるときの `localhost:<port>`、`TTS_ALLOWED_HOSTS` のホスト名（ポートは問わない）以外なら全パスで 421（`misdirected_request`）。DNS rebinding 対策。
- Origin: `GET` / `HEAD` / `OPTIONS` 以外で `Origin` ヘッダがあり、その host（ポート含む）が上の Host の許可に入らなければ 403（`forbidden_origin`）。`Origin: null` も 403。`Origin` が無い要求（curl など）は通す。
- CORS ヘッダは返さない（別オリジンのブラウザからは呼べない。JSON 必須と合わせて CSRF 対策）。

## エラー形式

```json
{ "error": { "code": "invalid_request", "message": "zenTts.speed must be between 0.5 and 1.5", "field": "zenTts.speed" } }
```

| HTTP | code | 意味 |
|---|---|---|
| 400 | `invalid_request` | パラメータ不正（範囲外・型違い・未知のフィールド・そのエンジンが対応しないオプション・本文が 1MB 超） |
| 400 | `bad_request` | リクエストターゲットが解釈できない（`GET //` など） |
| 401 | `unauthorized` | トークンが無い・違う |
| 403 | `forbidden` | 接続元が許可リスト外 |
| 403 | `forbidden_origin` | `Origin` が許可外・`null`（`GET` / `HEAD` / `OPTIONS` 以外） |
| 404 | `not_found` | エンジン・声・モデル・パスが無い |
| 405 | `method_not_allowed` | パスはあるがメソッドが違う。`Allow` ヘッダ付き |
| 409 | `conflict` | 同じ id のモデルがある・ダウンロード中（取得の要求が重なった）・削除の処理中 など |
| 413 | `text_too_long` | `text` が上限（`TTS_MAX_CHARS`、既定 2,000 字）を超えた。または前処理と読み辞書を通した後の文が上限の 3 倍（既定 6,000 字）を超えた |
| 415 | `unsupported_media_type` | JSON 以外の本文（JSON を受ける `POST` / `PUT` は本文が空でも） |
| 421 | `misdirected_request` | `Host` ヘッダが許可外・無い |
| 422 | `model_not_installed` | 声は登録済みだが重みが未取得 |
| 422 | `unprocessable_text` | 読み上げられない長さの語が含まれる（1 回の合成の上限を超える文を割り直しても収まらない） |
| 429 | `queue_full` | 待ち行列が満杯・同時ダウンロードが上限（2 件）。`Retry-After` ヘッダ（秒）付き |
| 500 | `internal_error` | 想定外の失敗 |
| 503 | `engine_unavailable` | モデル読み込み・合成プロセスの失敗。ffmpeg が無い（起動できない）ときに ffmpeg の要る要求（`wav` 以外、またはリサンプルの要る `wav`）。ffmpeg が 30 秒で終わらない（`timed out`）。待ち行列での待ちが `TTS_TIMEOUT_SEC` を超えた（`Retry-After` ヘッダ付き） |
| 504 | `timeout` | 合成が時間内（既定 60 秒）に終わらなかった |

**未知のフィールドは 400**（打ち間違いを黙って無視しない）。

---

## GET /healthz（HEAD も可）

モデルを読まずに返す。認証不要。`HEAD` は 200 で本文なし。

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
| `bitrate` | string | `mp3`:`128k` `opus`:`48k` `m4a`:`64k` | 圧縮形式のビットレート（`<数>k`）。範囲は `opus` `6k`〜`256k`、`mp3` `8k`〜`320k`、`m4a` `8k`〜`320k`。範囲外・`wav`・`flac` で指定すると 400（`field: bitrate`） |
| `volume` | number | `0` | 音量の増減（dB、`-20`〜`+12`）。クリップしないよう ±1 に丸める |
| `sentencePauseMs` | integer | `250` | 文と文の間の無音（ms、`0`〜`3000`） |
| `leadingSilenceMs` | integer | `0` | 先頭に足す無音（ms、`0`〜`3000`） |
| `trailingSilenceMs` | integer | `0` | 末尾に足す無音（ms、`0`〜`3000`） |
| `trimSilence` | boolean | `true` | 各文の前後の無音を詰めてから `sentencePauseMs` を入れる |
| `maxSentenceChars` | integer | `120` | 1 文の最大字数（`20`〜`120`）。超える文は読点・空白で分ける。ZEN-TTS で `speed` < 1 のときは `120 × speed` 字が上限になる |
| `preprocess` | boolean | `true` | 記号の読み替え（URL 削除、`%`→パーセント、`$20`→20ドル、`→`→から 等） |
| `dictionary` | boolean | `true` | 読み辞書（英字 → カタカナ）を通す |
| `readings` | object | `{}` | この要求だけの読み辞書の追加・上書き。`{ "Foo": "フー" }`。最大 200 語。読みはカタカナ。語・読みはそれぞれ 100 字まで（超えたら 400、`field` は `readings.<語>`） |
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

### 中断と待ち

- 応答を受け取る前にクライアントが接続を切ると、その要求の合成（待ち行列での待ち・エンジン・ffmpeg）を止め、応答は書かない。止めた合成はキャッシュに書かない。
  同じ合成を複数の要求が待っている（合流）ときは、待っている要求が 1 つでも残っていれば続ける（全員が切ったときだけ止める）。
- 待ち行列に入ってから合成が始まるまでが `TTS_TIMEOUT_SEC` を超えたら 503 `engine_unavailable`（`Retry-After: 5`）。合成そのものの上限（504）は始まってから数える。

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

合成せずに、前処理と読み辞書を通した後の文を返す。リクエストは `/v1/synthesize` と同じ（音声関係のフィールド・`zenTts` などエンジン固有のオプションも無視せず同じ規則で検証する）。
`sentences` は合成と同じ分け方: `maxSentenceChars` とエンジンの上限（ZEN-TTS で `zenTts.speed` < 1 なら `120 × speed` 字）の小さい方で切る。

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
  "ffmpeg": { "available": true, "path": "ffmpeg", "version": "7.0.2", "reason": null },
  "memory": { "rssBytes": 80000000 }
}
```

`loaded`・`kernel`・`process` は合成プロセス 1 つ分（互換のため残している）。`processes` はスロット（`TTS_CONCURRENCY` 個）ごとの合成プロセスで、
`state` は `starting`（声の読み込み中）・`idle`・`busy`（合成中）。`rssBytes` は取れなければ `null`。プロセスの無いスロットは載らない。

`ffmpeg` は `FFMPEG -version` を試した結果（`path` は `FFMPEG` の値、`version` は出力の 1 行目から取った版、取れなければ `null`、`reason` は使えない理由、使えれば `null`）。
起動時に 1 回試し、その後は状態取得・ffmpeg の要る要求のときに前回から 30 秒以上たっていれば試し直す（起動後に入れても 30 秒以内に反映される）。
`available` が `false` なら、ffmpeg の要る要求は ffmpeg を起動せずに 503 `engine_unavailable` を返す。

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
- `id`: `^[a-z0-9][a-z0-9_-]{0,31}$`。同じエンジンに同じ id があれば 409（その id を削除の処理中も 409）。
- `url`: `https://` のみ、ポートは 443 のみ（省略か明示の `:443`。ほかは 400）。ホストは `TTS_MODEL_HOSTS`（既定 `tts-models.zenryoku.work,huggingface.co,hf.co`）のどれか、またはそのサブドメインであること。リダイレクト先も同じ規則（ホスト・ポート）で検査する。リダイレクトは最大 5 回。上限 `TTS_MODEL_MAX_MB`（既定 512MB）。
- 時間の上限: 1 件の取得の全体で `TTS_MODEL_TIMEOUT_SEC`（既定 600 秒）、無通信が 30 秒。超えたら `error` にして途中のファイルを消す。
- 書き込みに失敗したとき（ディスクの空き不足・権限など）も `error` にして途中のファイルを消す。
- 登録は全エンジンの合計 50 件まで（超える追加は 400）。
- 同時ダウンロードは 2 件まで。超えたら 429（`Retry-After: 5`）で、登録しない。
- `sha256`: 任意。指定したら一致しないと `error`。省略したら取得したファイルの値を記録する（以後の再取得はその値で検査する）。
- 取得後、エンジンで読み込めるか検査する（ZEN-TTS: `.ztm` のヘッダと読み込み）。失敗なら `error` にしてファイルを消す。

### POST /v1/admin/models/{engine}/{id}/download

`pending` / `error` のモデルを取り直す。`202`。同じ id の取得が重なったら 2 つ目は 409、削除の処理中も 409。同時ダウンロードが 2 件なら 429（`Retry-After: 5`）。

### DELETE /v1/admin/models/{engine}/{id}

登録と重みのファイルを消す。既定の声に設定されているものは 409。ダウンロード中なら中止し、途中のファイル（`.part`）が消えるのを待ってから消す。その間に来た同じ id の追加・取り直しは 409。`204`。

### PUT /v1/admin/dictionary/{surface} / DELETE /v1/admin/dictionary/{surface}

ユーザー辞書の語を追加・更新（本文 `{ "reading": "フー" }`）・削除。`surface` は URL エンコード。
`surface`・`reading` はそれぞれ 100 字まで（超えたら 400、`field` は `surface` / `reading`）。
組み込み辞書の語を `PUT` すると、ユーザー辞書の値で上書きされる（組み込みの TSV は変えない）。
`DELETE` で消せるのはユーザー辞書の語だけ（組み込みは 404）。返り値は `GET /v1/dictionary` と同じ形。

### DELETE /v1/admin/cache

音声キャッシュを全部消す。`204`。

---

## 読み辞書の規則

- 適用の順: NFKC・URL とメールアドレスの削除 → 読み辞書 → 残りの記号の規則（日付・`%`・通貨・矢印・単位など）。`GPT-4o`・`COVID-19` も辞書に当たる。
- 照合は NFKC + 大文字小文字を同一視。長い語から当てる（`MacBook Pro` が `MacBook` より先）。
- 語の境界: 前が英数字でない、後ろが英字でない（`iPhone16` → アイフォーン16）。語の間の空白は改行をまたがない。
- 登録した語は全部大文字でも置き換える（`NASA` `API`）。
- 置き換えない: URL・メールアドレス・ドメイン（`example.com`）の中。ただし語自体がドットを含むもの（`Character.AI` `Booking.com`）はドメインの形でも当てる。
- 語の直後の所有格 `'s` は消し、`-数字`・`-英字` のハイフンは空白にする（`Pixel-9` → ピクセル 9）。
- 読みは全角カタカナ・長音符・中黒・空白だけ（半角カナは 400）。`#` で始まる語は 400。
- 語・読みはそれぞれ 100 字（コードポイント数）まで。前処理と辞書を通した後の文が `TTS_MAX_CHARS` の 3 倍を超えたら 413（`text_too_long`。`/v1/synthesize`・`/v1/normalize` とも）。
- `unknownWords` は辞書に無い英単語。全部大文字で 3 字以内（`API` `GPU`）は出さない。

## キャッシュ

キーは sha256(エンジン id・版、声 id とモデルの sha256、前処理・辞書を通した後の文、音声に効くすべてのパラメータ、出力形式)。
辞書を変えても、その文の読みが変わらなければヒットする。保存先 `TTS_CACHE_DIR`（既定 `~/.cache/tts-gateway/audio`）。
`cacheMaxMB` を超えたら最終アクセスの古い順に消す。`cacheTtlDays` を過ぎたものも消す。
キャッシュに当たった要求は、ffmpeg が無くても 200 を返す。

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
