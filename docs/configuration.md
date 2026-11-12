# 設定

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `TTS_HOSTS` | `127.0.0.1` | 待ち受けるアドレス（カンマ区切り、各アドレスに listen）。`0.0.0.0`・`::` は起動時エラー。まだ無いアドレス（起動直後の Tailscale など）は 5 秒ごとに再試行 |
| `TTS_PORT` | `8710` | ポート |
| `TTS_ALLOW_CIDRS` | `127.0.0.1/32,::1/128` | 接続を許す範囲。外は 403。IPv4-mapped IPv6（`::ffff:a.b.c.d`）は IPv4 として判定 |
| `TTS_TOKEN` | （無し） | 設定すると `/healthz` と設定画面の静的ファイル以外で `Authorization: Bearer <値>` が必須 |
| `TTS_ADMIN_TOKEN` | （無し） | 設定すると `/v1/admin/*` はこの値が必須（無ければ `TTS_TOKEN` の規則） |
| `TTS_DATA_DIR` | `$XDG_DATA_HOME/tts-gateway`（`~/.local/share/tts-gateway`） | `settings.json`・`models.json`・`models/<engine>/<id>.ztm`・ユーザー辞書 `readings.tsv` |
| `TTS_CACHE_DIR` | `$XDG_CACHE_HOME/tts-gateway/audio` | 音声キャッシュ |
| `TTS_CONCURRENCY` | `1` | 同時に合成する数（1〜2。2 なら合成プロセスも 2 つ） |
| `TTS_QUEUE_MAX` | `8` | 待ち行列の上限。超えたら 429 |
| `TTS_MAX_CHARS` | `2000` | `text` の上限（字）。超えたら 413 |
| `TTS_TIMEOUT_SEC` | `60` | 1 要求の合成の上限（秒）。超えたら 504 |
| `TTS_MODEL_HOSTS` | `tts-models.zenryoku.work,huggingface.co,hf.co` | モデルを取得してよいホスト（サブドメインも可。リダイレクト先も検査） |
| `TTS_MODEL_MAX_MB` | `512` | モデルの大きさの上限（MB） |
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
  ただし `PUT /v1/admin/dictionary/{語}` は全部大文字で 5 字以内の語の登録を今のところ断る（組み込み・要求ごとの `readings` では使える）。
- URL・メールアドレス・ドメイン（`example.com`）の中は置き換えない。ただし語自体がドットを含むもの（`Character.AI`・`Booking.com`）はドメインの形でも当てる。
- 語の直後の所有格 `'s` は消し、`-数字`・`-英字` のハイフンは空白にする（`Pixel-9` → ピクセル 9）。
- 読みは全角カタカナ・長音符・中黒・空白だけ（半角カナは不可）。
- `#` で始まる語は登録できない（`readings.tsv` ではコメントになるため）。

`POST /v1/normalize` の `unknownWords` に辞書に無い英単語が出るので、追加の候補にしてください（全部大文字で 3 字以内の語は ZEN-TTS が綴りで読むので出しません。`NASA`・`JSON` のような 4 字以上は出ます）。
`dictionary: false` で要求ごとに辞書を通さないこともできます。
