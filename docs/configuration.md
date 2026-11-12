# 設定

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `TTS_HOSTS` | `127.0.0.1` | 待ち受けるアドレス（カンマ区切り、各アドレスに listen）。IP アドレスだけ（`localhost` などのホスト名は起動時エラー）。`0.0.0.0`・`::` などの未指定アドレスは起動時エラー。まだ無いアドレス（起動直後の Tailscale など）は 5 秒ごとに再試行。ループバック以外を入れるとトークンが必須 |
| `TTS_PORT` | `8710` | ポート |
| `TTS_ALLOWED_HOSTS` | （無し） | `Host` ヘッダに許すホスト名（カンマ区切り、例 `tts.example.com,myhost.tailnet.example`）。ポートは問わず、大文字小文字は区別しない。`TTS_HOSTS` の各アドレス:ポートと `localhost:ポート`（ループバックで待ち受けるとき）はこれとは別に許す。どれにも入らない `Host` は 421 |
| `TTS_ALLOW_CIDRS` | `127.0.0.1/32,::1/128` | 接続を許す範囲。外は接続の時点で切断（HTTP 層でも 403）。IPv4-mapped IPv6（`::ffff:a.b.c.d`）は IPv4 として判定。`0.0.0.0/0`・`::/0` は起動時に警告 |
| `TTS_MAX_CONNECTIONS` | `64` | 待ち受けアドレスごとの同時接続の上限（1〜1024） |
| `TTS_TOKEN` | （無し） | 設定すると `/healthz` と設定画面の静的ファイル以外で `Authorization: Bearer <値>` が必須（`TTS_ADMIN_TOKEN` の値でも通る）。`change-me` で始まる値は起動時エラー、16 文字未満は警告 |
| `TTS_ADMIN_TOKEN` | （無し） | 設定すると `/v1/admin/*` はこの値が必須（無ければ `TTS_TOKEN` の規則）。値の規則は `TTS_TOKEN` と同じ |
| `TTS_ALLOW_NO_TOKEN` | （無し） | `1` にすると、`TTS_HOSTS` にループバック以外があってトークンが無くても起動する（起動時に警告）。それ以外の値や未設定では起動時エラー |
| `TTS_DATA_DIR` | `$XDG_DATA_HOME/tts-gateway`（`~/.local/share/tts-gateway`） | `settings.json`・`models.json`・`models/<engine>/<id>.ztm`・ユーザー辞書 `readings.tsv` |
| `TTS_CACHE_DIR` | `$XDG_CACHE_HOME/tts-gateway/audio` | 音声キャッシュ |
| `TTS_CONCURRENCY` | `1` | 同時に合成する数（1〜2。2 なら合成プロセスも 2 つ） |
| `TTS_AFFINITY_MAX_WAIT_MS` | `5000` | `TTS_CONCURRENCY=2` のとき、同じ声の要求に追い越された要求が、最初に追い越されてから待つ上限（ミリ秒、0〜60000）。過ぎたら声が違っても次の空きスロットで合成する。待ち行列に入ってから 15 秒たった要求は、これに関係なく最優先 |
| `TTS_QUEUE_MAX` | `8` | 待ち行列の上限。超えたら 429 |
| `TTS_MAX_CHARS` | `2000` | `text` の上限（字）。超えたら 413 |
| `TTS_TIMEOUT_SEC` | `60` | 1 要求の合成の上限（秒、合成が始まってから）。超えたら 504。待ち行列での待ちもこの秒数まで（超えたら 503、`Retry-After: 5`） |
| `TTS_MODEL_HOSTS` | `tts-models.zenryoku.work,huggingface.co,hf.co` | モデルを取得してよいホスト（サブドメインも可。リダイレクト先も検査） |
| `TTS_MODEL_MAX_MB` | `512` | モデルの大きさの上限（MB） |
| `TTS_MODEL_TIMEOUT_SEC` | `600` | モデル 1 件のダウンロードの上限（秒、10〜86400）。超えたら失敗。別に無通信 30 秒でも失敗 |
| `FFMPEG` | `ffmpeg` | ffmpeg のパス |

例は [`.env.example`](../.env.example)。

## 設定画面から変える設定

`settings.json`（データディレクトリ）に保存され、`GET` / `PUT /v1/admin/settings` でも読み書きできます。

| キー | 既定 | 説明 |
|---|---|---|
| `defaultEngine` | `zen-tts` | 既定のエンジン |
| `defaultVoices` | `{ "zen-tts": "marine" }` | エンジンごとの既定の声 |
| `idleUnloadSec` | `600` | この秒数使われなければ合成プロセスを終了してメモリを返す（0 で解放しない） |
| `cacheMaxMB` | `500` | キャッシュの上限（0 でキャッシュ無効） |
| `cacheTtlDays` | `30` | キャッシュの保持日数 |

## モデル（声）

- 公式の声は [`catalog/zen-tts.json`](../catalog/zen-tts.json)（URL・sha256）: `marine` `hashiro` `kai` `kikka`。
- サーバーを止めているとき: `npm run fetch-models -- <id>`（id を省くと全部）。`node src/cli.ts models list` で一覧。
- サーバーが動いているとき: 設定画面の「モデル」か `POST /v1/admin/models`（`fetch-models` は同じ `models.json` を書くので使わない）。
- URL で追加する場合は `https` かつ `TTS_MODEL_HOSTS` のホストだけ。取得後に sha256 とエンジンでの読み込みを検査します。

## 読み辞書

英字の語をカタカナの読みに置き換えます（`GitHub` → ギットハブ）。

| 種類 | 場所 | 優先 |
|---|---|---|
| 組み込み | [`dict/readings.tsv`](../dict/readings.tsv)（`語<TAB>読み`） | 低 |
| ユーザー | データディレクトリの `readings.tsv`。設定画面か `PUT /v1/admin/dictionary/{語}` で編集 | 中 |
| 要求ごと | `/v1/synthesize` の `readings: { "Foo": "フー" }` | 高 |

適用の順（`/v1/normalize` と `/v1/synthesize` で同じ）:

1. NFKC で正規化し、URL・メールアドレスを消す（`preprocess: false` なら NFKC だけ）
2. 読み辞書を当てる（`dictionary: false` なら飛ばす）
3. 残りの記号の規則（日付・`%`・通貨・矢印・単位・型番のハイフンなど）

辞書が記号の規則より先なので、記号や数字を含む語（`GPT-4o`・`COVID-19`）もそのまま登録して当てられます。
辞書の読み（カタカナ）は 3 の規則では変わりません。

照合の規則:

- NFKC で正規化し、大文字小文字を区別しない。長い語から当てる（`MacBook Pro` が `MacBook` より先）。
- 語の境界: 前が英数字でない、後ろが英字でない（`iPhone16` → アイフォーン16）。語の間の空白は改行をまたがない。
- 登録した語は全部大文字でも置き換える（`NASA`・`API`）。登録しなければ ZEN-TTS がそのまま読む。
- URL・メールアドレス・ドメイン（`example.com`）の中は置き換えない。ただし語自体がドットを含むもの（`Character.AI`・`Booking.com`）はドメインの形でも当てる。
- 語の直後の所有格 `'s` は消し、`-数字`・`-英字` のハイフンは空白にする（`Pixel-9` → ピクセル 9）。
- 読みは全角カタカナ・長音符・中黒・空白だけ（半角カナは不可）。
- `#` で始まる語は登録できない（`readings.tsv` ではコメントになるため）。

`POST /v1/normalize` の `unknownWords` に辞書に無い英単語が出るので、追加の候補にしてください（全部大文字で 3 字以内の語は ZEN-TTS が綴りで読むので出しません。`NASA`・`JSON` のような 4 字以上は出ます）。
`dictionary: false` で要求ごとに辞書を通さないこともできます。
