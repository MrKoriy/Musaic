# Musaic

Self-hosted music streaming: a server with your library, likes and recommendations, plus native Apple clients (iOS, macOS, watchOS, widget + Live Activity).

## Components

| Directory | What | Stack |
|---|---|---|
| `server/` | HTTP API: auth, library/likes sync, artwork proxy, downloads, "My Wave" recommendations, lyrics pipeline, provider integrations (Yandex Music, SoundCloud, YouTube, VK) | Bun + Hono 4 + `bun:sqlite` |
| `MusaicApp/` | SwiftUI clients: iOS 17+, macOS 15+, watchOS app, Now Playing widget & Live Activity | Swift 6, strict concurrency, XcodeGen |
| `server/sidecar/` | Optional Python sidecar for media tasks: Yandex/YouTube libraries (yandex-music, ytmusicapi, yt-dlp), ffmpeg helpers | Python 3.11 |
| `deploy/` | systemd units for the production server | — |
| `deploy-server.sh` | Release-symlink deploy with health gate and rollback | — |

## Feature highlights

- **«Моя волна»** — recommendation engine with live session feedback (skips/likes steer the stream mid-session), Daily Mix, mood filters. See `MY-WAVE-PLAN.md`.
- **Lyrics** — LRCLIB/Genius fetch plus an AI pipeline: whisper.cpp forced alignment against reference text produces LRC **and per-word timestamps**; the app renders karaoke highlighting. Per-source highlight offset is server-computed.
- **Loudness normalization** — EBU R128 measurement (or ReplayGain tags when the file carries them) per track; the player applies per-track gain (target −16 LUFS).
- **Offline & extras** — track downloads with LRU/TTL eviction, iPod-style click wheel, watch remote control, interactive widget and Dynamic Island controls.

## Quickstart

### Server

```sh
cd server
bun install
bun run dev        # watch mode; production: bun src/index.ts
```

Checks before every commit:

```sh
cd server
bun run typecheck && bun test src/__tests__ && bun run lint
```

### App

```sh
cd MusaicApp
xcodegen generate
open Musaic.xcodeproj   # schemes: Musaic (iOS), MusaicMac, MusaicWatch, MusaicWidget
```

The Xcode project is generated — edit `project.yml`, not `Musaic.xcodeproj`.
New source files under `Models/`, `Services/`, `Stores/`, `Views/`, `Widgets/`,
`WatchApp/` are picked up automatically on the next `xcodegen generate`.

## CI & releases

- Push to `main` runs **CI**: server tests + lint, macOS and iOS app builds (`.github/workflows/ci.yml`, macos-26 runner, Xcode 26.6).
- Push a tag `v*.*.*` runs **Release**: builds the unsigned macOS app and the server bundle, attaches them to a GitHub Release (`.github/workflows/release.yml`).

```sh
git tag v0.2.0 && git push origin v0.2.0
```

## Docs

- `DESIGN.md` — design system (gold palette, glass, motion, components)
- `RESEARCH.md` — technical research: lyrics alignment, loudness, iOS 27 adoption map
- `MY-WAVE-PLAN.md` — «Моя волна» recommendation engine: state and roadmap
- `tasks.md` — current improvement backlog (audit 2026-09-23)
