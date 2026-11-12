# 運用

## 速度とメモリの目安

Intel N100、WASM カーネル、合成 1 本での実測。

| 項目 | 値 |
|---|---|
| 1 文（2〜4 秒の音声）の合成 | 0.2〜0.5 秒 |
| 最初の要求（声の読み込みを含む） | 約 6 秒 |
| メモリ（RSS） | サーバー本体 約 100MB ＋ 合成プロセス 約 280MB（声 1 つを読み込んだとき） |

声のモデルは最初の要求で読み込み、`idleUnloadSec`（既定 600 秒）使われなければ合成プロセスごと終了してメモリを返します。

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
- **接続元**: `TTS_ALLOW_CIDRS` に入らない接続元は 403。外からの接続を許すなら範囲をできるだけ狭くしてください。
- **トークン**: ループバック以外から使うなら `TTS_TOKEN` と `TTS_ADMIN_TOKEN` を設定してください。`TTS_ADMIN_TOKEN` は管理 API（モデルの追加・削除・辞書・設定）だけを守ります。
- **CSRF**: CORS ヘッダを返さず、本文は JSON だけを受け付けます（別オリジンのページからの要求を防ぐため）。
- **モデルの取得**: `https` で `TTS_MODEL_HOSTS` のホストだけ（リダイレクト先も検査）、上限 `TTS_MODEL_MAX_MB`、sha256 の検査、エンジンでの読み込み検査を通ったものだけ使います。
- **TLS**: 終端しません。ネットワーク越しに使うときは VPN（Tailscale など）かリバースプロキシの内側に置いてください。
