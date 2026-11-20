# コンテナでのデプロイ（Docker / Coolify）

tts-gateway を Docker イメージにして Coolify で動かすための手順です。
systemd で直接動かす方法は [docs/deployment.md](docs/deployment.md)、環境変数の全部は [docs/configuration.md](docs/configuration.md) にあります。

## 構成の要点

| 項目 | 内容 |
|---|---|
| 種類 | HTTP サーバー 1 プロセス（＋合成用の子プロセス。同じコンテナの中） |
| ランタイム | Node.js 26.12.1（TypeScript を直接実行。ビルド工程なし） |
| ポート | `8710`（コンテナ内。`TTS_PORT`） |
| データベース | **なし**。設定・声のモデル・ユーザー辞書をファイルで `/data` に保存 |
| 永続化が必要 | `/data`（必須）。`/cache`（任意。音声キャッシュ） |
| 外向きの通信 | 声のモデルの取得だけ（`https://tts-models.zenryoku.work`、443）。Webhook・定期実行・外部 API なし |
| セッション | なし（Cookie を使わない。API トークンを `Authorization: Bearer` で送る） |
| ログ | stdout / stderr に JSON を 1 件 1 行 |
| ヘルスチェック | `GET /health`・`/health/live`・`/health/ready`（認証不要） |

声のモデル（ZEN-TTS の重み、1 声 約 28MB）は再配布できないため、イメージにもリポジトリにも入っていません。
起動後に公式 CDN から `/data` へ取得します（[初回の設定](#初回の設定声の追加)）。

## Docker でのビルドと起動

```sh
docker build -t tts-gateway .

docker volume create tts-gateway-data
docker run -d --name tts-gateway \
  -p 127.0.0.1:8710:8710 \
  -v tts-gateway-data:/data \
  -e TTS_TOKEN="$(openssl rand -hex 32)" \
  tts-gateway

curl -fsS http://127.0.0.1:8710/health        # {"status":"ok","version":"..."}
docker logs -f tts-gateway
docker stop tts-gateway                        # SIGTERM で終了（終了コード 0）
```

- 非 root（`node`、uid 1000）で動きます。`/data` にホストのディレクトリを bind mount するときは、所有者を uid 1000 にしてください。
- `node` を PID 1 として直接起動します（pm2・systemd は使いません）。
- Docker Compose は不要です（サービスが 1 つで、DB などの付随サービスが無いため）。

## 環境変数

### 必須

| 変数 | 内容 |
|---|---|
| `TTS_TOKEN` | API トークン。**無いと起動しません。** `openssl rand -hex 32` などで作る（`change-me` で始まる値は拒否） |
| `TTS_ALLOWED_HOSTS` | 公開するホスト名（例 `tts.example.com`）。カンマ区切り。リバースプロキシ経由で使うなら必須（無いと 421 になる） |

### 任意（よく使うもの）

| 変数 | イメージの既定 | 内容 |
|---|---|---|
| `TTS_ADMIN_TOKEN` | （無し） | 管理 API（`/v1/admin/*`）専用のトークン。分けると、API を呼ぶ側に管理権限を渡さずに済む |
| `APP_ENV` | （無し） | ログの `env` に入る実行環境の名前（`production` など） |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_FORMAT` | `json` | `json` / `text` |
| `SERVICE_NAME` | `tts-gateway` | ログの `service` |
| `TTS_CONCURRENCY` | `1` | 合成の同時実行数（1〜2）。2 にするならメモリ上限を 1G 以上に |
| `TTS_ALLOW_CIDRS` | ループバック＋プライベートアドレス | 接続元の許可範囲。プロキシの後ろでは接続元が常にプロキシになるので、通常は変えない |

### イメージが設定済みのもの（通常は変えない）

`TTS_HOSTS=0.0.0.0`・`TTS_ALLOW_ANY_ADDRESS=1`（コンテナ内の全アドレスで待ち受け）、`TTS_PORT=8710`、`TTS_DATA_DIR=/data`、`TTS_CACHE_DIR=/cache`、`NODE_ENV=production`。

秘密情報は `TTS_TOKEN` と `TTS_ADMIN_TOKEN` だけです。ビルド時に必要な変数・秘密情報はありません。

## Coolify への登録

| 設定 | 値 |
|---|---|
| Source | この GitHub リポジトリ、ブランチ `main` |
| Build Pack | Dockerfile |
| Base Directory | `/` |
| Dockerfile Location | `/Dockerfile` |
| Ports Exposes | `8710` |
| Ports Mappings | 空（Traefik 経由で公開するので不要） |
| Domains | 公開するホスト名（`TTS_ALLOWED_HOSTS` と同じ名前） |
| Persistent Storage | Volume Mount を `/data` に（必須）。`/cache` は任意 |
| Environment Variables | `TTS_TOKEN`・`TTS_ALLOWED_HOSTS`・`APP_ENV`（Runtime だけでよい。トークンは Lock を勧める） |
| Health Check | 下の「ヘルスチェック」 |
| Resource Limits | Memory limit `1g`、CPU limit `1.5`（目安。下の「リソース」） |
| Stop Grace Period | 既定（30 秒）のままでよい（通常 1 秒以内に終了、最長 10 秒） |
| Auto deploy | GitHub App で接続すれば `main` への push でデプロイ。公開リポジトリの URL だけで登録した場合は、GitHub 側に Webhook を手で登録する |

### ヘルスチェック

- Dockerfile に `HEALTHCHECK`（`/health/ready` を 30 秒ごと）が入っています。Coolify の画面の Healthcheck を**無効**にしておけばこれが使われます。
- 画面の Healthcheck を有効にする場合: Method `GET`、Scheme `http`、Host `127.0.0.1`、Port `8710`、Path `/health/ready`、Interval 30、Timeout 5、Retries 3、Start period 20。イメージに `curl` が入っているので動きます。
- **Host は `127.0.0.1` か `localhost` にしてください。** それ以外の Host ヘッダは 421 になります。
- チェックはコンテナの中から行うので、Cloudflare Access を通りません。

| パス | 意味 |
|---|---|
| `/health`、`/health/live` | プロセスが応答できる（待ち受け開始後は常に 200） |
| `/health/ready` | 要求を受けられる。終了処理中・`/data` に書けないときは 503 `{"status":"unavailable","reason":"..."}` |
| `/healthz` | 以前からある死活確認（`/health` と同じ。互換のため残している） |

声が 1 つも入っていなくても ready は 200 です（初回デプロイの直後に設定画面で声を入れるため）。

### リソース

| 構成 | メモリの目安 |
|---|---|
| `TTS_CONCURRENCY=1` | 本体 約 100MB ＋ 合成プロセス 約 280MB。上限 800MB〜1GB |
| `TTS_CONCURRENCY=2` | 合計 約 660MB。上限 1GB 以上 |

合成は CPU を 1 コア使い切ります。ほかのアプリと同居させるなら CPU limit `1.5` 程度を勧めます。
数値は Intel N100 で systemd から動かしたときの実測で、コンテナでは未計測です。

### 初回の設定（声の追加）

`/data` が空の状態では声がありません。デプロイ後に一度だけ行います。

- 画面から: `https://<ホスト名>/admin/` を開き、トークンを入力して「モデル」でカタログから声を追加する。
- API から:

  ```sh
  curl -fsS -X POST https://<ホスト名>/v1/admin/models \
    -H "Authorization: Bearer $TTS_ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d '{"engine":"zen-tts","catalog":"marine"}'
  ```

  本文の形は [docs/api.md](docs/api.md) の「POST /v1/admin/models」を見てください。

## 永続化するデータ

| パス | 中身 | 失うと |
|---|---|---|
| `/data/settings.json` | 設定画面で変えた設定 | 既定値に戻る |
| `/data/models.json`、`/data/models/` | 登録した声と重み | 声を取り直す必要がある |
| `/data/readings.tsv` | ユーザー辞書 | 登録した読みが消える |
| `/cache` | 合成済み音声のキャッシュ | 同じ文をもう一度合成するだけ（永続化は任意） |

- コンテナの書き込み層には永続データを置きません。`/cache` をマウントしない場合、キャッシュは再デプロイで消えます。
- 書き込みは一時ファイルに書いてから rename します。
- **1 つの `/data` を複数のコンテナで同時に使わないでください**（レプリカは 1）。ローリング更新で新旧が数秒重なる間に設定画面で変更すると、その変更が失われることがあります。
- バックアップは `/data` を tar で固めるだけです（`models/` は取り直せるので、`settings.json`・`models.json`・`readings.tsv` だけでも足りる）。復旧は同じ場所に戻して再起動します。

### データベースについて

このアプリは DB を使っていません。データは小さな JSON 2 つ、TSV 1 つ、重みのファイル（1 声 約 28MB）です。
外部 DB（PostgreSQL など）へは移していません。理由は次のとおりです。

- 重みはエンジンがファイルパスで読むので、DB に入れてもファイルへ書き戻す必要がある。
- 残りは 1 プロセスが読み書きする数 KB の設定で、DB にすると接続・マイグレーション・障害時の扱いが増えるだけになる。

`DATABASE_URL` は使いません。データの場所は `TTS_DATA_DIR` で切り替えます。
複数レプリカで動かす必要が出たら、設定と辞書を外部 DB へ移すことを検討します（未解決の課題）。

## ログ

stdout（`debug`・`info`）と stderr（`warn`・`error`）に JSON を 1 件 1 行で出します。Loki へはアプリから送りません（Coolify 側のログ転送に任せる）。

```json
{"time":"2026-01-01T00:00:00.000Z","level":"info","service":"tts-gateway","env":"production","msg":"request","requestId":"…","method":"POST","path":"/v1/synthesize","status":200,"durationMs":412,"remote":"10.0.1.5","bytes":48213}
```

- 共通の項目: `time`（UTC）、`level`、`service`（`SERVICE_NAME`）、`env`（`APP_ENV`。空なら無し）、`msg`。
- アクセスログは 1 要求 1 行（`msg: "request"`）。ヘルスチェックのアクセスは `debug` なので既定では出ません。
- エラーは `err.stack` にスタックトレースが入ります。
- **リクエスト ID**: `X-Request-Id` があればその値、無ければ `Cf-Ray`、どちらも無ければ生成します。応答の `X-Request-Id` とログの `requestId` で、要求とエラーを突き合わせられます。
- ヘッダ・本文・クエリ文字列はログに出しません（トークンと読み上げる文章を残さないため）。
- 合成用の子プロセス（ZEN-TTS）が直接書いた出力は JSON になりません（通常は何も出しません）。

## Cloudflare Access との関係

| 観点 | 状況 |
|---|---|
| リバースプロキシ経由 | 動く。プロキシが付ける `Host` を `TTS_ALLOWED_HOSTS` に入れる（無いと 421） |
| HTTPS | アプリは TLS もリダイレクトもしない。Cloudflare / Traefik に任せる。絶対 URL を作らないので `X-Forwarded-Proto` は不要 |
| Cookie・セッション | 使っていない。設定画面はトークンをブラウザの `localStorage` に保存する |
| WebSocket・SSE | 使っていない（設定画面は 1 秒ごとのポーリング） |
| Webhook・外部からの呼び出し | なし |
| 応答時間 | 合成は最長 `TTS_TIMEOUT_SEC`（既定 60 秒）。Cloudflare の上限（100 秒）に収まる |
| CSRF 対策 | `Origin` のホスト名が `TTS_ALLOWED_HOSTS` に無い書き込みは 403。公開ホスト名を入れてあれば設定画面は動く |

- **二重の認証になります。** Cloudflare Access（Google ログイン）を通ったあと、設定画面でも API トークンの入力が必要です。
  アプリは Cloudflare のユーザー情報を使いません。`Cf-Access-Jwt-Assertion` の検証もしていません（ヘッダの有無を認証の根拠にしていない）。
  トークン入力を省きたい場合は、Access の JWT の署名を検証して管理者として扱う実装が要ります（未解決の課題）。
- **API クライアント（ほかのプロジェクト）は Google ログインを通れません。** 次のどれかにします。
  LAN や Tailscale の中から使うだけなら 1 か 2 で足り、Cloudflare を通す必要はありません。
  1. **LAN 内から Traefik へ直接**: 内部の DNS（または hosts）で公開ホスト名を Coolify のホストに向け、`http(s)://<ホスト名>/` を呼ぶ。Cloudflare を通らないので Access の対象外。
  2. 同じ Docker ネットワークのコンテナから `http://<コンテナ名>:8710` を直接呼ぶ（その名前を `TTS_ALLOWED_HOSTS` に足す）。
  3. **Cloudflare Access のサービストークン**（外から呼ぶ必要があるとき）: Access のポリシーに Service Auth を足し、クライアントは `CF-Access-Client-Id` / `CF-Access-Client-Secret` と `Authorization: Bearer <TTS_TOKEN>` を送る。
  4. Tailscale 側のアドレスへ Ports Mappings で出す。Coolify ではドメインのルーティングとローリング更新を外れるので、ほかに手が無いときだけ。
- どの経路でも `TTS_TOKEN` は必須のままにしてください。LAN や Docker ネットワークの中から来る要求は Cloudflare Access を通っていません。

## 開発サーバーからの運用・調査

本番ホストの Docker ソケットや管理者権限は使いません。接続先と認証情報は環境変数で持ち、リポジトリに入れません。

| 用途 | 手段 | 環境変数の例 |
|---|---|---|
| 死活 | `curl -fsS "$TTS_PROD_URL/health/ready"`（Access を通る経路ではサービストークンが要る） | `TTS_PROD_URL`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET` |
| 状態 | `GET /v1/admin/status`（声・合成プロセス・ffmpeg・キャッシュ） | `TTS_PROD_ADMIN_TOKEN` |
| ログ | Loki の HTTP API | `LOKI_URL`（＋必要なら認証） |
| デプロイ状態 | Coolify API（`read` 権限のトークン） | `COOLIFY_URL`、`COOLIFY_TOKEN` |
| コード更新 | GitHub の PR → `main` へのマージで自動デプロイ | — |

```sh
# 直近 1 時間のエラー（ラベル名はログ転送の設定に合わせる）
curl -G -s "$LOKI_URL/loki/api/v1/query_range" \
  --data-urlencode 'query={service="tts-gateway"} | json | level="error"' \
  --data-urlencode "start=$(date -d '1 hour ago' +%s)000000000" | jq '.data.result[].values[][1]'

# リクエスト ID で 1 件の要求を追う
#   {service="tts-gateway"} | json | requestId="<X-Request-Id の値>"
```

- DB が無いので SQL での調査はありません。データの確認は管理 API（読むだけの `GET`）で行います。
- 読むだけのトークンと変更できるトークンを分けたいときは、通常の API に `TTS_TOKEN`、管理 API に `TTS_ADMIN_TOKEN` を使い分けます。
  管理 API の中には読み取り専用の権限がありません（未解決の課題）。
- デプロイ操作は Coolify の `deploy` 権限のトークンが要ります。調査用の `read` トークンとは別にしてください。

## 本番の切り替え手順

現行（systemd）は止めずに並行で動かし、利用側の接続先を移してから止めます。

1. Coolify に登録してデプロイする（上の表）。`/health/ready` が 200 になることを確かめる。
2. データを移す。どちらかを選ぶ。
   - **入れ直す**（データが少ないとき）: 設定画面で声を追加し、ユーザー辞書と設定を登録し直す。
     現行の内容は `GET /v1/dictionary`（`source` が `user` のもの）と `GET /v1/admin/settings` で確認できる。
   - **コピーする**: 現行のデータディレクトリ（既定 `~/.local/share/tts-gateway`）を固めて、新環境の `/data` に展開する。
     パスはデータディレクトリからの相対で持っているので、そのまま使える。

     ```sh
     # 現行サーバーで（読むだけ）
     tar -C ~/.local/share/tts-gateway -czf tts-gateway-data.tgz .
     # 新環境の Docker ホストで（コンテナを止めた状態で。ボリューム名は Coolify の画面で確認する）
     docker run --rm -v <ボリューム名>:/data -v "$PWD":/in:ro busybox \
       sh -c 'tar -C /data -xzf /in/tts-gateway-data.tgz && chown -R 1000:1000 /data'
     ```
3. 新環境で合成を試す（`POST /v1/synthesize` を wav と mp3 で）。
4. 利用側のプロジェクトの接続先とトークンを新環境に変える。
5. 現行サーバーのログで、要求が来なくなったことを確かめる。
6. 現行を止める: `systemctl --user disable --now tts-gateway`。データディレクトリと unit は、しばらく消さずに残す。

## ロールバック手順

- **切り替えの取り消し**: 利用側の接続先を現行サーバーに戻す。現行を止めていたら `systemctl --user enable --now tts-gateway`。
  現行のデータは手順 2 で読んだだけなので、切り替え前のまま残っています（切り替え後に新環境で足した辞書・設定は現行には無い）。
- **デプロイの取り消し**（新環境に移ったあと）: Coolify で前のデプロイに戻す。`/data` の形式はバージョン間で変えていないので、データはそのまま使えます。

## 未解決の課題

- このリポジトリの開発サーバーには Docker が無く、イメージのビルドとコンテナでの動作は GitHub Actions（`.github/workflows/ci.yml`）で確かめています。CI は重みを取得しないので、**コンテナ内での実際の合成は初回デプロイで確かめる必要があります**（メモリ・速度の実測も）。
- Cloudflare Access の JWT 検証は実装していません（トークンの二重入力が残る）。
- 管理 API に読み取り専用の権限がありません。
- レプリカは 1 つだけです（データがファイルのため）。
- Loki のラベル（`service` など）はログ転送側の設定で決まります。上の検索例はその設定に合わせて直してください。
