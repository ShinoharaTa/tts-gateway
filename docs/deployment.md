# 運用

## 速度とメモリの目安

Intel N100、WASM カーネル、合成 1 本での実測。

| 項目 | 値 |
|---|---|
| 1 文（2〜4 秒の音声）の合成 | 0.2〜0.5 秒 |
| 最初の要求（声の読み込みを含む） | 約 6 秒 |
| メモリ（RSS） | サーバー本体 約 100MB ＋ 合成プロセス 約 280MB（声 1 つを読み込んだとき） |

声のモデルは最初の要求で読み込み、`idleUnloadSec`（既定 600 秒）使われなければ合成プロセスごと終了してメモリを返します
（`TTS_CONCURRENCY=2` では合成プロセスごとに数える）。

`TTS_CONCURRENCY=2` では子プロセス（合成プロセス）2 つで合計約 660MB を使います。
その場合は unit の `MemoryHigh=800M` `MemoryMax=1G` を勧めます（例の unit の既定 `MemoryHigh=600M` `MemoryMax=800M` は合成 1 本向け）。

## systemd（ユーザーユニット）

例: [`deploy/systemd/tts-gateway.service`](../deploy/systemd/tts-gateway.service)（`Nice=10`・`CPUQuota=150%`・`MemoryHigh=600M`・`MemoryMax=800M`）。

```sh
mkdir -p ~/.config/systemd/user ~/.config/tts-gateway
cp deploy/systemd/tts-gateway.service ~/.config/systemd/user/
cp .env.example ~/.config/tts-gateway/env && chmod 600 ~/.config/tts-gateway/env   # 値を自分の環境に合わせて直す
# unit の WorkingDirectory と ExecStart の node のパスを自分の環境に合わせる
systemctl --user daemon-reload
systemctl --user enable --now tts-gateway
journalctl --user -u tts-gateway -f
```

- unit の `Environment=PATH=` に `~/.local/bin` を入れてあります。ffmpeg が別の場所にあるなら `FFMPEG` にフルパスを書いてください。
- ログアウト後も動かすには `loginctl enable-linger` が必要です。

## ネットワークとセキュリティ

- **待ち受け**: 既定は `127.0.0.1` だけ。ほかのマシンから使うときは `TTS_HOSTS` に特定のアドレス（LAN・VPN のアドレス）を足します。`0.0.0.0`・`::` は起動時エラー。
- **接続元**: `TTS_ALLOW_CIDRS` に入らない接続元は接続の時点で切断します（HTTP 層でも 403）。外からの接続を許すなら範囲をできるだけ狭くしてください。同時接続は `TTS_MAX_CONNECTIONS`（既定 64）まで、ヘッダは 10 秒・要求全体は 30 秒以内に届かなければ切断します。
- **トークン**: `TTS_HOSTS` にループバック以外があるときは `TTS_TOKEN` か `TTS_ADMIN_TOKEN` が無いと起動しません（トークン無しで動かすなら `TTS_ALLOW_NO_TOKEN=1`）。`TTS_ADMIN_TOKEN` は管理 API（モデルの追加・削除・辞書・設定）だけを守り、通常の API にも使えます。
- **Host / Origin**: `Host` が `TTS_HOSTS` のアドレス・`localhost`・`TTS_ALLOWED_HOSTS` 以外なら 421（DNS rebinding 対策）。`GET` / `HEAD` / `OPTIONS` 以外で `Origin` がそれ以外なら 403。名前（Tailscale の MagicDNS 名など）でアクセスするならその名前を `TTS_ALLOWED_HOSTS` に入れてください。
- **CSRF**: CORS ヘッダを返さず、本文は JSON だけを受け付けます（別オリジンのページからの要求を防ぐため）。
- **モデルの取得**: `https`・ポート 443 で `TTS_MODEL_HOSTS` のホストだけ（リダイレクト先も検査、最大 5 回）、上限 `TTS_MODEL_MAX_MB`・`TTS_MODEL_TIMEOUT_SEC`（無通信は 30 秒）、sha256 の検査、エンジンでの読み込み検査を通ったものだけ使います。
- **TLS**: 終端しません。ネットワーク越しに使うときは VPN（Tailscale など）かリバースプロキシの内側に置いてください。
- **リバースプロキシ**: プロキシの後ろに置くと接続元が常にプロキシになるので、`TTS_ALLOW_CIDRS` の判定は意味を持ちません。その場合はプロキシ側で接続元を制限し、トークンを必ず設定してください。プロキシが付ける `Host`（`tts.example.com` など）を `TTS_ALLOWED_HOSTS` に入れます。
- **systemd の強化**: 例の unit は `NoNewPrivileges`・`PrivateTmp`・`ProtectSystem=strict`（書けるのは `~/.local/share/tts-gateway` と `~/.cache/tts-gateway` だけ）・`RestrictAddressFamilies`・`LockPersonality` を指定しています。`TTS_DATA_DIR` / `TTS_CACHE_DIR` を変えたら `ReadWritePaths` も合わせてください。 なお `PrivateTmp` と `ProtectSystem` は、環境によっては --user の unit で効きません（非特権のユーザー名前空間が制限されている Ubuntu など）。効かなくても起動はします。
