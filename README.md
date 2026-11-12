# tts-gateway

日本語の音声合成（TTS）を、ほかのプロジェクトから 1 回の HTTP リクエストで使うための API サーバーです。
エンジンは差し替えられる作りで、最初のエンジンとして [ZEN-TTS](https://github.com/zenryokukikai/zen-tts) に対応しています。
GPU の無い小さなサーバー（Intel N100 / 16GB）で、他のサービスと同居させる前提で作っています。

**音声合成：ZEN-TTS（[https://zenryokukikai.com](https://zenryokukikai.com)）**

> [!NOTE]
> このリポジトリは個人による非公式のプロジェクトで、ZEN-TTS の開発元（全力機械株式会社）とは関係ありません。

<details>
<summary>English overview</summary>

tts-gateway is a small, self-hosted HTTP API for Japanese text-to-speech with pluggable engines. The first engine is
[ZEN-TTS](https://github.com/zenryokukikai/zen-tts) (CPU only). Send JSON, get wav / mp3 / opus / m4a / flac back.
It has a reading dictionary for Latin-script words (e.g. "GitHub" → ギットハブ), a disk cache, a bounded queue, and a
small admin page for adding voices and editing the dictionary.

ZEN-TTS is **not** covered by this repository's MIT license. It is under the
[ZEN-TTS License](https://github.com/zenryokukikai/zen-tts/blob/v1.3.0/LICENSE.md): credit
"Speech synthesis: ZEN-TTS (https://zenryokukikai.com)" is required wherever the software **or audio made with it** is
used; modification, redistribution of the weights, and use for training / distillation / evaluation of other models are
prohibited. The weights are not included here; each user downloads them from the official CDN.

</details>

## できること

- **エンジン共通の API**: `POST /v1/synthesize` に JSON を送ると音声が返ります。エンジン・声はパラメータで選びます。
- **出力形式**: wav / mp3 / opus / m4a / flac。サンプルレート・ビットレート・音量・文間や前後の無音も指定できます。
- **ZEN-TTS のオプションをすべて指定可能**: 感情の配合、文の途中での感情の変化、抑揚、速さ、高さ、アクセント辞書 など。
- **読み辞書**: 英字のまま来た語をカタカナの読みに置き換えます（`GitHub` → ギットハブ、`Hugging Face` → ハギングフェイス）。
  記号も日本語に読み替えます（`50%` → 50パーセント、`$20` → 20ドル、URL は読まない）。
- **キャッシュと待ち行列**: 同じ内容の要求はディスクのキャッシュから返します。合成は 1 本ずつで、混んだら 429 を返します。
- **省メモリ**: 声のモデルは最初の要求で読み込み、しばらく使われなければ解放します。
- **設定画面**: 声（モデル）の追加・削除、読み辞書の編集、試聴、既定の声の設定。
- **API 仕様**: [docs/api.md](docs/api.md) と [openapi.yaml](openapi.yaml)（OpenAPI 3.1）。

## ZEN-TTS のライセンスについて（必ずお読みください）

このサーバーは音声合成エンジンに ZEN-TTS を使っています。ZEN-TTS は **ZEN-TTS ライセンス** で提供されています。
このリポジトリの MIT ライセンスとは別のものです。原文: https://github.com/zenryokukikai/zen-tts/blob/v1.3.0/LICENSE.md

要点（正確には原文に従ってください）:

- **クレジットの表示が必須**: 「音声合成：ZEN-TTS（https://zenryokukikai.com ）」を、利用者が普通に見つけられる場所に表示します。URL はリンクにします。
- **改変の禁止**: ZEN-TTS のソースコードとモデルの重みを改変してはいけません。
- **再配布の禁止**: ZEN-TTS 本体と重みを、第三者に再配布・販売・譲渡などしてはいけません。
- **学習・蒸留・評価への利用の禁止**: ZEN-TTS、その重み、それで作った音声を、他の機械学習モデルの学習・蒸留・評価のデータに使ってはいけません。

**このサーバーで作った音声を使うアプリ・サイト・作品でも、クレジットの表示が必要です。**
API はクレジットを 2 か所で返します。

- `GET /v1/engines` の `credit`
- 音声のレスポンスの `X-TTS-Credit` ヘッダ（URL エンコード）

設定画面にも表示しています。

表示の例:

```html
<p>音声合成：<a href="https://zenryokukikai.com">ZEN-TTS</a>（https://zenryokukikai.com）</p>
```

動画や音声だけの作品では、説明欄・概要欄に書きます。

**重み（`.ztm`）はこのリポジトリに含みません。** 利用者が公式 CDN（https://tts-models.zenryoku.work/ ）から自分で取得します（下の「セットアップ」）。

## 必要なもの

- **Node.js 26.12.1 以上**: zen-tts の要件です。TypeScript は Node の type stripping でそのまま実行し、ビルドはしません。
- **ffmpeg**: mp3 / opus / m4a / flac への変換と、サンプルレートの変換に使います。wav をエンジンのサンプルレートのまま出すだけなら要りません。
- **GPU は不要**: CPU で動きます。

目安（Intel N100、WASM カーネル、合成 1 本）:

| 項目 | 値 |
|---|---|
| 1 文（2〜4 秒の音声）の合成 | 0.2〜0.5 秒 |
| 最初の要求（声の読み込みを含む） | 約 6 秒 |
| メモリ（RSS） | サーバー本体 約 100MB ＋ 合成プロセス 約 280MB（声 1 つを読み込んだとき） |

## セットアップ

```sh
git clone https://github.com/ShinoharaTa/tts-gateway.git
cd tts-gateway
npm ci
npm run fetch-models -- marine     # 全力 マリン（約 28MB）を公式 CDN から取得。id を省くと 4 声すべて
npm start                          # http://127.0.0.1:8710
```

- **取得できる声**: `marine`（全力 マリン）、`hashiro`（全力 ハシロウ）、`kai`（全力 カイ）、`kikka`（全力 キッカ）。
  URL と sha256 は `catalog/zen-tts.json` にあります。
- **サーバーが動いているとき**: `fetch-models` はサーバーと同じデータディレクトリに書くため、使わないでください。
  代わりに設定画面の「モデル」から追加します。
- **一覧の表示**: `node src/cli.ts models list` で、登録済みのモデルとその状態を出します。

## 使い方

```sh
# 声とオプションの一覧
curl -sS http://127.0.0.1:8710/v1/engines

# 合成（mp3）
curl -sS -X POST http://127.0.0.1:8710/v1/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"GitHub に Claude のコードを push しました。","voice":"marine","format":"mp3"}' \
  -o out.mp3

# 感情・速さ・高さを指定
curl -sS -X POST http://127.0.0.1:8710/v1/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"本日はご来店いただき、ありがとうございます。","format":"opus","zenTts":{"emotion":{"happy":70,"neutral":30},"speed":1.1,"pitch":1}}' \
  -o out.ogg

# 読みの確認（合成しない）
curl -sS -X POST http://127.0.0.1:8710/v1/normalize \
  -H 'Content-Type: application/json' -d '{"text":"Hugging Face から取得"}'
```

ほかのプロジェクトから（JavaScript）:

```js
const res = await fetch('http://127.0.0.1:8710/v1/synthesize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' /*, Authorization: `Bearer ${token}` */ },
  body: JSON.stringify({ text: 'こんにちは。', format: 'mp3' }),
});
if (!res.ok) throw new Error((await res.json()).error.message);
const audio = new Uint8Array(await res.arrayBuffer());
const credit = decodeURIComponent(res.headers.get('X-TTS-Credit') ?? ''); // 使う側でも表示する
```

### 主なエンドポイント

仕様の正本は [docs/api.md](docs/api.md)、機械可読な仕様は [openapi.yaml](openapi.yaml) です。

| メソッド・パス | 内容 |
|---|---|
| `GET /healthz` | 死活確認（認証不要） |
| `GET /v1/engines` | エンジン・声・対応オプション・クレジット |
| `POST /v1/synthesize` | テキスト → 音声 |
| `POST /v1/normalize` | 前処理と読み辞書を通した後の文・当たった語・辞書に無い語（合成しない） |
| `GET /v1/dictionary` | 読み辞書（組み込み + ユーザー） |
| `/v1/admin/*` | 状態・設定・モデル・ユーザー辞書・キャッシュ（設定画面が使う） |

- **本文**: `application/json` だけを受け付けます（ほかは 415）。
- **未知のフィールド**: 400 を返します。打ち間違いを黙って無視しないためです。
- **エラー**: どれも `{"error":{"code","message","field"}}` の形です。
- **混雑時**: 待ち行列が満杯なら 429（`Retry-After` 付き）を返します。

## 読み辞書

英字の語をカタカナの読みに置き換える辞書です。

- **組み込み辞書**: [`dict/readings.tsv`](dict/readings.tsv)。形式は `語<TAB>読み` です。
- **ユーザー辞書**: 設定画面の「読み辞書」か、`PUT /v1/admin/dictionary/{語}` で追加します。
  データディレクトリの `readings.tsv` に保存され、組み込みより優先されます。
- **要求ごとの指定**: `readings: {"Foo": "フー"}` で、その要求だけの読みを足せます。
  `dictionary: false` にすると辞書を通しません。

照合の規則:

- 大文字小文字を区別せず、長い語から当てます。
- 次の 2 つは置き換えません。どちらも ZEN-TTS の規則で読ませます。
  - 全部大文字で 5 字以内の語（`API`・`GPU` など）
  - URL・ドメインの中

`/v1/normalize` の `unknownWords` に、辞書に無い英単語が出ます。辞書に足す候補にしてください。
よく使う語の追加は PR も歓迎です。

## 設定画面

`http://<host>:<port>/admin/` を開きます。

- **できること**: 状態の確認、試聴（読みと、辞書に無い語も表示）、モデルの追加と削除、読み辞書の編集、設定の変更、クレジットの表示。
- **表示**: スマートフォンの幅でも使えます。外部の CDN は使いません。
- **トークン**: 設定しているときは、画面でトークンを入力します（ブラウザの localStorage に保存）。
- **モデルの追加元**: 公式カタログから選ぶか、URL と sha256 を指定して追加します。
  取得できるホストは `TTS_MODEL_HOSTS` に入れたものだけです。

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

例は [`.env.example`](.env.example) にあります。

## 常駐させる（systemd のユーザーユニット）

例は [`deploy/systemd/tts-gateway.service`](deploy/systemd/tts-gateway.service) です。
資源の上限として `Nice=10`・`CPUQuota=150%`・`MemoryHigh=600M`・`MemoryMax=800M` を入れてあります。

```sh
mkdir -p ~/.config/systemd/user ~/.config/tts-gateway
cp deploy/systemd/tts-gateway.service ~/.config/systemd/user/
cp .env.example ~/.config/tts-gateway/env && chmod 600 ~/.config/tts-gateway/env   # 値を自分の環境に合わせて直す
# unit の WorkingDirectory と ExecStart の node のパスを自分の環境に合わせる
systemctl --user daemon-reload
systemctl --user enable --now tts-gateway
journalctl --user -u tts-gateway -f
```

- **PATH**: unit の `Environment=PATH=` に `~/.local/bin` を入れてあります。ffmpeg が別の場所にあるなら、`FFMPEG` にフルパスを書いてください。
- **ログアウト後も動かす**: `loginctl enable-linger` が必要です。

## セキュリティ

- **待ち受けは既定で `127.0.0.1` だけ**です。
  - ほかのマシンから使うときは、`TTS_HOSTS` に特定のアドレス（LAN や VPN のアドレス）を足します。
  - `0.0.0.0`・`::`（全アドレス）を指定すると起動時エラーになります。
- **接続元は `TTS_ALLOW_CIDRS` で絞ります**。既定はループバックだけです。外からの接続を許すときは、範囲をできるだけ狭くしてください。
- **トークン**: ループバック以外から使うなら、`TTS_TOKEN` と `TTS_ADMIN_TOKEN` を設定してください。
  - `TTS_ADMIN_TOKEN` は管理 API（モデルの追加・削除・辞書・設定）だけを守るトークンです。
- **CSRF 対策**: CORS ヘッダを返さず、本文は JSON だけを受け付けます。別オリジンのページからの要求を防ぐためです。
- **モデルの取得**: 次の条件を満たしたものだけを使います。
  - `https` で、`TTS_MODEL_HOSTS` のホストから取得する（リダイレクト先も検査）
  - 大きさが `TTS_MODEL_MAX_MB` 以下
  - sha256 が合う
  - エンジンで読み込める
- **TLS**: このサーバーは TLS を終端しません。ネットワーク越しに使うときは、VPN（Tailscale など）かリバースプロキシの内側に置いてください。

## ロードマップ

- [VOICEVOX エンジンの追加](https://github.com/ShinoharaTa/tts-gateway/issues/8)
- そのほかは [Issues](https://github.com/ShinoharaTa/tts-gateway/issues) を見てください。

## 開発

```sh
npm test                                        # node --test test/*.test.ts（偽のエンジンを使い、重みは不要）
npx --yes @redocly/cli@latest lint openapi.yaml # OpenAPI の検査（依存には入れていない）
```

内部の構成は [docs/design.md](docs/design.md) にあります。

API を変えるときは、[docs/api.md](docs/api.md) と [openapi.yaml](openapi.yaml) を同じ PR で直してください。

## ライセンス

- **このリポジトリのコード**: [MIT](LICENSE)（Copyright (c) 2026 ShinoharaTa）。対象はこのリポジトリのコードだけです。
- **ZEN-TTS（依存パッケージと声の重み）**: ZEN-TTS ライセンスです。上の「ZEN-TTS のライセンスについて」を見てください。
- **第三者のもの**: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にあります。
