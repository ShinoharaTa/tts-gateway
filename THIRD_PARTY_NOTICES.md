# Third-party notices

このリポジトリのコード（`LICENSE`、MIT）以外に、次のものを使います。どれもこのリポジトリには含みません。

## ZEN-TTS

- 依存パッケージ `zen-tts`（`github:zenryokukikai/zen-tts#v1.3.0`）と、利用者が公式 CDN（https://tts-models.zenryoku.work/ ）から取得する声の重み（`.ztm`）。
- ライセンス: **ZEN-TTS ライセンス 1.0**（Copyright (c) 2026 Zenryoku Kikai Inc. / 全力機械株式会社）。MIT ではありません。
  原文: https://github.com/zenryokukikai/zen-tts/blob/v1.3.0/LICENSE.md （`npm ci` 後は `node_modules/zen-tts/LICENSE.md`）
- 要点: クレジット「音声合成：ZEN-TTS（https://zenryokukikai.com ）」の表示が必須（作った音声を使うアプリ・作品も含む）、
  改変の禁止、本体・重みの再配布の禁止、本体・重み・作った音声を機械学習の学習・蒸留・評価に使うことの禁止。

## ZEN-TTS が含む第三者のもの

ZEN-TTS 自身の第三者の表示は `node_modules/zen-tts/THIRD_PARTY_NOTICES.md`
（https://github.com/zenryokukikai/zen-tts/blob/v1.3.0/THIRD_PARTY_NOTICES.md ）にあります。v1.3.0 で挙がっているもの:

- Open JTalk（HTS Working Group / 名古屋工業大学。修正 BSD ライセンス）: モーラ表
- VITS（Jaehyeon Kim。MIT License）: 注意機構の実装の参考
- mecab-ipadic-neologd: 英単語の読みの一部（読みのモデルの学習データ）
- CMU Pronouncing Dictionary: ローマ字の除外リスト・英単語の表
- 12dicts: 英単語の表の語の選定
- IPAdic 2.7.0: 読みのモデルの学習ラベル

各ライセンスの全文は上のファイルを参照してください。

## ffmpeg

mp3 / opus / m4a / flac への変換とリサンプルに、利用者の環境にある `ffmpeg` を**外部コマンドとして呼ぶだけ**です（`FFMPEG` 環境変数、既定は PATH の `ffmpeg`）。
ffmpeg をこのリポジトリに含めたり、リンクしたり、配布したりはしません。ffmpeg とそのエンコーダ（libmp3lame・libopus など）のライセンスは、
利用者が入れた ffmpeg のビルドに従います（https://ffmpeg.org/legal.html ）。
