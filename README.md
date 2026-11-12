# tts-gateway

English | [日本語](README.ja.md)

A small self-hosted HTTP API for Japanese text-to-speech, built so that other projects can get audio with a single request.
Engines are pluggable; the first one is [ZEN-TTS](https://github.com/zenryokukikai/zen-tts).

**Speech synthesis: ZEN-TTS ([https://zenryokukikai.com](https://zenryokukikai.com))**

## Features

- **One request, one audio file.** POST JSON and get back wav, mp3, opus, m4a or flac. Choose the engine and voice per request.
- **Reading dictionary.** English words are replaced with katakana readings before synthesis (`GitHub` → ギットハブ).
- **Light on resources.** Results are cached on disk, and requests go through a bounded queue. Voice models are loaded on first use and unloaded when idle.
- **Admin page.** Add or remove voices, edit the dictionary, and try out voices from a browser.
- **No GPU needed.** Runs on a small CPU-only server, such as an Intel N100.

## License and terms of use

- **ZEN-TTS has its own license.** It is under the [ZEN-TTS License](https://github.com/zenryokukikai/zen-tts/blob/v1.3.0/LICENSE.md), not this repository's MIT license. Read it before use; it also restricts modification, redistribution and use for machine learning.
- **Credit is required wherever the audio is used.** That includes apps, sites and works that only use audio made with this server. Show "Speech synthesis: ZEN-TTS (https://zenryokukikai.com)" with the URL as a link.
  - The API returns this text in `GET /v1/engines` and in the `X-TTS-Credit` response header.
- **Voice weights are not included.** Each user downloads them from the official CDN.
- **Unofficial project.** This is an independent project, not affiliated with the developer of ZEN-TTS.

## Quick start

Requires Node.js 26.12.1 or later, and ffmpeg for formats other than wav.

```sh
git clone https://github.com/ShinoharaTa/tts-gateway.git
cd tts-gateway
npm ci
npm run fetch-models -- marine   # download one voice (about 28 MB) from the official CDN
npm start                        # listens on http://127.0.0.1:8710
```

```sh
curl -sS -X POST http://127.0.0.1:8710/v1/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"GitHub に push しました。","format":"mp3"}' \
  -o out.mp3
```

## Usage

From JavaScript:

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

Main endpoints:

| Endpoint | Description |
|---|---|
| `POST /v1/synthesize` | Text to audio. Every engine option can be set: emotion, speed, pitch, accent dictionary, and so on |
| `POST /v1/normalize` | Shows the text the engine will read, after preprocessing and the dictionary, without synthesizing |
| `GET /v1/engines` | Lists engines, voices, the options they support, and the credit text |
| `GET /healthz` | Health check |

Full reference: [docs/api.md](docs/api.md) and [openapi.yaml](openapi.yaml) (OpenAPI 3.1).

## Admin page

Open `http://<host>:8710/admin/` to check the server status, add or remove voices, edit the reading dictionary, change settings, and try voices.

## Using it over the network

The server listens only on `127.0.0.1` by default. To serve other machines, set three things:

- `TTS_HOSTS`: the addresses to listen on
- `TTS_ALLOW_CIDRS`: the client networks that may connect
- `TTS_TOKEN` and `TTS_ADMIN_TOKEN`: the API tokens (required when `TTS_HOSTS` has a non-loopback address; the server refuses to start without one)

The server does not handle TLS, so keep it behind a VPN or a reverse proxy. See [docs/deployment.md](docs/deployment.md).

## Documentation

The documents under `docs/` are written in Japanese.

- [docs/api.md](docs/api.md): API reference
- [docs/configuration.md](docs/configuration.md): environment variables, voices, and the reading dictionary
- [docs/deployment.md](docs/deployment.md): systemd setup, security, and performance figures
- [docs/design.md](docs/design.md): internal design

## Roadmap

- [VOICEVOX engine](https://github.com/ShinoharaTa/tts-gateway/issues/8)
- See [Issues](https://github.com/ShinoharaTa/tts-gateway/issues) for everything else.

## Development

```sh
npm test                                        # uses a fake engine, no weights needed
npx --yes @redocly/cli@latest lint openapi.yaml
```

When you change the API, update `docs/api.md` and `openapi.yaml` in the same pull request.

## License

- **Code in this repository:** [MIT](LICENSE).
- **ZEN-TTS, including its package and voice weights:** the [ZEN-TTS License](https://github.com/zenryokukikai/zen-tts/blob/v1.3.0/LICENSE.md).
- **Other third-party notices:** see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
