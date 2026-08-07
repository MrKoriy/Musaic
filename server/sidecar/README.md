# Musaic media sidecar

A tiny localhost-only Python service that wraps the brittle, fast-moving music
libraries so the Bun/Hono server doesn't have to track their churn:

| Library | Purpose |
|---|---|
| [`yandex-music`](https://github.com/MarshalX/yandex-music-api) (MarshalX) | Yandex Music search / metadata / audio download |
| [`ytmusicapi`](https://github.com/sigma67/ytmusicapi) | YouTube Music search / metadata |
| [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) | YouTube audio stream resolution |
| `ffmpeg` (optional) | Local audio fingerprint for audio-similarity recommendations |

## Setup

```bash
cd server/sidecar
./setup.sh        # creates .venv and installs requirements
```

The Bun server auto-spawns the sidecar on startup (using `.venv/bin/python`)
unless `SIDECAR_AUTOSTART=0`. You can also run it standalone:

```bash
.venv/bin/python app.py        # listens on 127.0.0.1:8770
```

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `MUSAIC_SIDECAR_PORT` | `8770` | Localhost port |
| `YANDEX_PROXY` | _(empty)_ | HTTP(S) proxy for **all** Yandex egress (API + audio). Leave empty when the server runs on a Russian IP. Set to e.g. `http://user:pass@ru-host:port` when the server is outside RU/CIS. |
| `YT_POT_BASE_URL` | _(empty)_ | bgutil PO-token provider base URL (e.g. `http://127.0.0.1:4416`). Enables web_music/mweb fallbacks when the `android` client can't serve a track. |
| `YT_COOKIES_FILE` | _(empty)_ | Path to a YouTube cookies.txt for age/region-gated tracks and better reliability. |
| `YT_AUTH_FILE` | _(empty)_ | ytmusicapi browser-auth headers file — improves search reliability vs unauthenticated. |
| `MUSIC_DIR` | _(empty)_ | Root allowed for the optional `/audio/embedding` endpoint. |
| `AUDIO_EMBEDDING_ROOT` | _(empty)_ | Additional allowed root for local audio fingerprints. |

The **Yandex OAuth token is never stored here** — the Bun server holds it
(encrypted) and passes it per-request via the `X-Yandex-Token` header.

## Streaming & geo

All Yandex network traffic (search and the actual audio bytes via
`/yandex/download/<id>`) happens in this process, so a single `YANDEX_PROXY`
covers geo-routing. The Bun server fetches the bytes over localhost and proxies
them to the app with HTTP Range support — so the phone's own VPN/location never
matters.

YouTube streams are resolved with the `android` player client, which (as of
2026) still yields direct progressive audio without a PO token. If that path
degrades, run a bgutil PO-token provider and set `YT_POT_BASE_URL`.

The optional audio embedding endpoint is disabled by default. Set
`AUDIO_EMBEDDINGS_ENABLED=1` in the Bun server and make `ffmpeg` available on
the host to enable the nightly local-audio fingerprint job. It is deliberately
implemented as a lightweight fingerprint rather than a mandatory Essentia
installation so the normal server remains small and reliable.
