# tts-gateway

[ZEN-TTS](https://github.com/zenryokukikai/zen-tts) を使う、日本語の音声合成（TTS）の HTTP API サーバーと設定画面です。
テキストを JSON で送ると wav / mp3 / opus / m4a / flac の音声が返ります。英字の語の読み辞書、記号の読み替え、文分割、無音の調整、
ディスクキャッシュ、待ち行列、モデル（声）の追加・削除を画面から行えます。

**音声合成：ZEN-TTS（https://zenryokukikai.com ）**

## ZEN-TTS とライセンスについて（必ずお読みください）

このサーバーは音声合成エンジンに ZEN-TTS（全力機械株式会社）を使っています。ZEN-TTS は **ZEN-TTS ライセンス** で提供されており、
このリポジトリの MIT ライセンスとは別です。原文: https://github.com/zenryokukikai/zen-tts/blob/v1.3.0/LICENSE.md

要点（正確には原文に従ってください）:

- **クレジットの表示が必須**: 「音声合成：ZEN-TTS（https://zenryokukikai.com ）」を、利用者が普通に見つけられる場所に表示し、URL はリンクにします。
- **改変の禁止**: ZEN-TTS のソースコード・モデルの重みを改変してはいけません。
- **再配布の禁止**: ZEN-TTS 本体・重みを第三者に再配布・販売・譲渡などしてはいけません。
- **学習・蒸留・評価への利用の禁止**: ZEN-TTS、その重み、それで作った音声を、他の機械学習モデルの学習・蒸留・評価のデータに使ってはいけません。

**このサービスで作った音声を使うアプリ・サイト・作品でも、上のクレジットの表示が必要です。**
API は帰属表示を `X-TTS-Credit` ヘッダ（URL エンコード）と `GET /v1/engines` の `credit` で返します。設定画面にもクレジットを表示しています。

**重み（`.ztm`）はこのリポジトリに含みません。** 利用者が公式 CDN（https://tts-models.zenryoku.work/ ）から自分で取得します（下の「セットアップ」）。

## 必要なもの

- Node.js **26.12.1 以上**（zen-tts の要件。TypeScript を Node の type stripping でそのまま実行し、ビルドはしません）
- `ffmpeg`（mp3 / opus / m4a / flac と、サンプルレートの変換に使う。wav をエンジンのサンプルレートのまま出すだけなら不要）
- メモリ: 合成プロセス 1 つあたり約 250〜300MB（声 1 つを読み込んだとき）

## セットアップ

```sh
git clone <このリポジトリ> tts-gateway
cd tts-gateway
npm ci
npm run fetch-models -- marine     # 全力 マリン（約 28MB）を公式 CDN から取得。id を省くと 4 声すべて
npm start                          # http://127.0.0.1:8710
```

- 取得できる声: `marine`（全力 マリン）、`hashiro`（全力 ハシロウ）、`kai`（全力 カイ）、`kikka`（全力 キッカ）。一覧は `catalog/zen-tts.json`（URL・sha256）。
- `fetch-models` はサーバーと同じデータディレクトリに書きます。サーバーが動いているときは、設定画面の「モデル」から追加してください。
- `node src/cli.ts models list` で登録済みのモデルと状態を表示します。

確認:

```sh
curl -sS http://127.0.0.1:8710/healthz
curl -sS -X POST http://127.0.0.1:8710/v1/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"GitHub に Claude のコードを push しました。","voice":"marine","format":"mp3"}' \
  -o out.mp3
```

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

例は [`.env.example`](.env.example)。

## API

仕様の正本は [docs/api.md](docs/api.md)、機械可読な仕様は [openapi.yaml](openapi.yaml)（OpenAPI 3.1）です。概要:

| メソッド・パス | 内容 |
|---|---|
| `GET /healthz` | 死活確認（認証不要） |
| `GET /v1/engines` | エンジン・声・対応オプション・クレジット |
| `POST /v1/synthesize` | テキスト → 音声。`format`・`sampleRate`・`bitrate`・`volume`・無音・文分割・辞書・`zenTts`（感情・速さ・高さ・アクセント辞書 など） |
| `POST /v1/normalize` | 合成せずに、前処理と読み辞書を通した後の文・当たった語・辞書に無い語 |
| `GET /v1/dictionary` | 読み辞書（組み込み + ユーザー） |
| `GET /v1/admin/status` | 状態（読み込み中の声・合成プロセスのメモリ・待ち行列・キャッシュ） |
| `GET` / `PUT /v1/admin/settings` | 既定の声・アイドル解放・キャッシュの上限と日数 |
| `GET /v1/admin/catalog` | 追加できる公式モデル |
| `GET` / `POST /v1/admin/models` | 登録済みモデル / 追加（非同期でダウンロード） |
| `POST /v1/admin/models/{engine}/{id}/download` | 取り直し |
| `DELETE /v1/admin/models/{engine}/{id}` | 削除 |
| `PUT` / `DELETE /v1/admin/dictionary/{surface}` | ユーザー辞書の追加・更新・削除 |
| `DELETE /v1/admin/cache` | キャッシュを全部消す |

- 本文は `application/json` だけ（ほかは 415）。未知のフィールドは 400（打ち間違いを黙って無視しない）。
- 同じ内容の要求はキャッシュから返します（`X-Cache: hit`）。合成中の同じ要求は合流して 1 回だけ合成します。
- 声のモデルは最初の要求で読み込み（数秒）、`idleUnloadSec`（既定 600 秒）使われなければ合成プロセスごと終了してメモリを返します。

## 設定画面

`http://<host>:<port>/admin/` を開きます。状態・試聴（読みと辞書に無い語の表示つき）・モデルの追加と削除・読み辞書・設定・クレジット。
スマートフォンの幅でも使えます。外部の CDN は使いません。トークンを設定しているときは、画面でトークンを入力します（ブラウザの localStorage に保存）。

## systemd（ユーザーユニット）

例: [`deploy/systemd/tts-gateway.service`](deploy/systemd/tts-gateway.service)（`Nice=10`・`CPUQuota=150%`・`MemoryHigh=600M`・`MemoryMax=800M`）。

```sh
mkdir -p ~/.config/systemd/user ~/.config/tts-gateway
cp deploy/systemd/tts-gateway.service ~/.config/systemd/user/
cp .env.example ~/.config/tts-gateway/env   # 値を自分の環境に合わせて直す。chmod 600 推奨
# WorkingDirectory と ExecStart の node のパスを自分の環境に合わせる
systemctl --user daemon-reload
systemctl --user enable --now tts-gateway
journalctl --user -u tts-gateway -f
```

systemd から起動すると `PATH` に `~/.local/bin` などが入らないことがあります。ffmpeg がそこにあるなら `FFMPEG` にフルパスを書いてください。

## セキュリティ

- **待ち受けは既定で `127.0.0.1` だけ**です。ほかのマシンから使うときは、`TTS_HOSTS` に特定のアドレス（VPN のアドレスなど）を足します。
  `0.0.0.0`・`::`（全アドレス）は起動時エラーにしています。
- **接続元は `TTS_ALLOW_CIDRS` で絞ります**（既定はループバックだけ）。外からの接続を許すなら、範囲をできるだけ狭くしてください。
- **トークン**: ループバック以外から使うなら `TTS_TOKEN` と `TTS_ADMIN_TOKEN` を設定してください。管理 API（モデルの追加・削除・辞書・設定）は
  `TTS_ADMIN_TOKEN` で分けられます。
- CORS ヘッダは返さず、本文は JSON だけを受け付けます（別オリジンのページからの CSRF を防ぐため）。
- モデルの取得は `https` で、`TTS_MODEL_HOSTS` のホストだけ（リダイレクト先も検査）、上限 `TTS_MODEL_MAX_MB`、sha256 の検査、エンジンでの読み込み検査をしてから使います。
- TLS は終端しません。ネットワーク越しに使うときは、VPN（Tailscale など）かリバースプロキシの内側に置いてください。

## 開発

```sh
npm test                                        # node --test test/*.test.ts（偽のエンジンを使い、重みは不要）
npx --yes @redocly/cli@latest lint openapi.yaml # OpenAPI の検査（依存には入れていない）
```

内部の構成は [docs/design.md](docs/design.md)。

## ライセンス

- このリポジトリのコード: [MIT](LICENSE)（Copyright (c) 2026 ShinoharaTa）。**このリポジトリのコードだけが対象**です。
- ZEN-TTS（依存パッケージと声の重み）: ZEN-TTS ライセンス（上の「ZEN-TTS とライセンスについて」）。
- 第三者のもの: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
