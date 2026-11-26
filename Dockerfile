# syntax=docker/dockerfile:1
# tts-gateway のコンテナイメージ（DEPLOYMENT.md）。
# ZEN-TTS の重み（*.ztm）は入れない。起動後に設定画面か管理 API で公式 CDN から /data に取得する。

ARG NODE_VERSION=26.12.1

# ---- 依存の取得（package-lock.json で固定）----
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
# zen-tts は GitHub から取る。lock の resolved は git+ssh だが、鍵を使わないよう https に寄せる
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- 実行 ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# ffmpeg: mp3 / opus / m4a / flac とリサンプル。curl: Coolify の画面で設定するヘルスチェック用
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    # コンテナの中では自分のアドレスが分からないので全アドレスで待ち受ける（公開範囲はコンテナのネットワークで決まる）
    TTS_HOSTS=0.0.0.0 \
    TTS_ALLOW_ANY_ADDRESS=1 \
    TTS_PORT=8710 \
    # ループバック（ヘルスチェック）とプライベートアドレス（リバースプロキシ・同じネットワークのコンテナ）
    TTS_ALLOW_CIDRS=127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16 \
    TTS_DATA_DIR=/data \
    TTS_CACHE_DIR=/cache \
    LOG_FORMAT=json \
    LOG_LEVEL=info \
    SERVICE_NAME=tts-gateway

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY src ./src
COPY catalog ./catalog
COPY dict ./dict
COPY public ./public

# 永続データ（/data）とキャッシュ（/cache）。マウントした名前付きボリュームはこの所有者を引き継ぐ。
# VOLUME は宣言しない（マウントし忘れたときに匿名ボリュームが再デプロイのたびに残るのを避ける）
RUN mkdir -p /data /cache && chown node:node /data /cache
USER node
EXPOSE 8710

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${TTS_PORT}/health/ready" -o /dev/null || exit 1

# exec 形式: node が PID 1 で SIGTERM を受ける
CMD ["node", "src/cli.ts", "serve"]
