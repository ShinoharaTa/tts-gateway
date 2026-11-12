# tts-gateway

[English](README.md) | 日本語

日本語の音声合成（TTS）を、ほかのプロジェクトから 1 回の HTTP リクエストで使うための、自前で動かす小さな API サーバーです。
エンジンは差し替えられる作りで、最初のエンジンは [ZEN-TTS](https://github.com/zenryokukikai/zen-tts) です。

**音声合成：ZEN-TTS（[https://zenryokukikai.com](https://zenryokukikai.com)）**

## 特徴

- **1 回の要求で音声を返す**: JSON を送ると、wav・mp3・opus・m4a・flac のどれかで音声を返します。エンジンと声は要求ごとに選べます。
- **読み辞書**: 英単語を合成の前にカタカナの読みに置き換えます（`GitHub` → ギットハブ）。
- **資源を食わない**: 結果をディスクにキャッシュし、要求は上限付きの待ち行列で順に処理します。声のモデルは最初に使うときに読み込み、使われなくなったら解放します。
- **設定画面**: ブラウザから声の追加・削除、読み辞書の編集、試聴ができます。
- **GPU が要らない**: Intel N100 のような、CPU だけの小さなサーバーで動きます。

## ライセンスと利用条件

- **ZEN-TTS は別のライセンスです**: このリポジトリの MIT ではなく、[ZEN-TTS ライセンス](https://github.com/zenryokukikai/zen-tts/blob/v1.3.0/LICENSE.md)に従います。改変・再配布・機械学習への利用にも制限があるので、使う前に原文を読んでください。
- **音声を使う場所でクレジットの表示が必要です**: このサーバーで作った音声を使うだけのアプリ・サイト・作品も含みます。「音声合成：ZEN-TTS（https://zenryokukikai.com ）」を表示し、URL はリンクにします。
  - API はこの文言を `GET /v1/engines` と、レスポンスの `X-TTS-Credit` ヘッダで返します。
- **声の重みは含めていません**: 利用者が各自、公式 CDN から取得します。
- **非公式のプロジェクトです**: ZEN-TTS の開発元とは関係なく、個人が作っています。

## クイックスタート

Node.js 26.12.1 以上が必要です。wav 以外の形式で出すときは ffmpeg も要ります。

```sh
git clone https://github.com/ShinoharaTa/tts-gateway.git
cd tts-gateway
npm ci
npm run fetch-models -- marine   # 声を 1 つ（約 28MB）公式 CDN から取得
npm start                        # http://127.0.0.1:8710 で待ち受け
```

```sh
curl -sS -X POST http://127.0.0.1:8710/v1/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"GitHub に push しました。","format":"mp3"}' \
  -o out.mp3
```

## 使い方

JavaScript から呼ぶ例:

```js
const res = await fetch('http://127.0.0.1:8710/v1/synthesize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    text: '本日はご来店いただき、ありがとうございます。',
    voice: 'marine',
    format: 'opus',
    zenTts: { emotion: { happy: 70, neutral: 30 }, speed: 1.1 },
  }),
});
if (!res.ok) throw new Error((await res.json()).error.message);
const audio = new Uint8Array(await res.arrayBuffer());
```

主なエンドポイント:

| エンドポイント | 内容 |
|---|---|
| `POST /v1/synthesize` | テキストを音声にする。感情・速さ・高さ・アクセント辞書など、エンジンのオプションをすべて指定できる |
| `POST /v1/normalize` | 前処理と読み辞書を通した後に、エンジンが読む文を返す（合成はしない） |
| `GET /v1/engines` | エンジン・声・対応するオプション・クレジットの一覧 |
| `GET /healthz` | 死活確認 |

詳しい仕様は [docs/api.md](docs/api.md) と [openapi.yaml](openapi.yaml)（OpenAPI 3.1）にあります。

## 設定画面

`http://<host>:8710/admin/` を開くと、サーバーの状態の確認、声の追加・削除、読み辞書の編集、設定の変更、試聴ができます。

## ネットワーク越しに使うとき

既定では `127.0.0.1` だけで待ち受けます。ほかのマシンから使うときは、次の 3 つを設定します。

- `TTS_HOSTS`: 待ち受けるアドレス
- `TTS_ALLOW_CIDRS`: 接続を許すネットワーク
- `TTS_TOKEN` と `TTS_ADMIN_TOKEN`: API のトークン（`TTS_HOSTS` にループバック以外があるときは必須。無いと起動しません）

TLS には対応していないので、VPN かリバースプロキシの内側に置いてください。詳しくは [docs/deployment.md](docs/deployment.md) を見てください。

## ドキュメント

- [docs/api.md](docs/api.md): API の仕様
- [docs/configuration.md](docs/configuration.md): 環境変数・声（モデル）・読み辞書
- [docs/deployment.md](docs/deployment.md): systemd での常駐・セキュリティ・速度とメモリの目安
- [docs/design.md](docs/design.md): 内部設計

## ロードマップ

- [VOICEVOX エンジンの追加](https://github.com/ShinoharaTa/tts-gateway/issues/8)
- そのほかは [Issues](https://github.com/ShinoharaTa/tts-gateway/issues) にあります。

## 開発

```sh
npm test                                        # 偽のエンジンを使うので重みは要らない
npx --yes @redocly/cli@latest lint openapi.yaml
```

API を変えるときは、`docs/api.md` と `openapi.yaml` を同じ PR で直してください。

## ライセンス

- **このリポジトリのコード**: [MIT](LICENSE)
- **ZEN-TTS（パッケージと声の重み）**: [ZEN-TTS ライセンス](https://github.com/zenryokukikai/zen-tts/blob/v1.3.0/LICENSE.md)
- **そのほかの第三者のもの**: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
