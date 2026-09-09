# Musaic

Self-hosted music streaming: a server with your library, likes and recommendations, plus native Apple clients (iOS, macOS, watchOS, widget).

## Components

| Directory | What | Stack |
|---|---|---|
| `server/` | HTTP API: auth, library/likes sync, artwork proxy, downloads, "My Wave" recommendations, provider integrations (Yandex Music, SoundCloud, YouTube, VK) | Bun + Hono 4 + `bun:sqlite` |
| `MusaicApp/` | SwiftUI clients: iOS 17+, macOS 15+, watchOS app + Now Playing widget | Swift 6, strict concurrency, XcodeGen |
| `server/sidecar/` | Optional Python sidecar for media tasks (ffmpeg queue) | Python 3.11 |
| `deploy/` | systemd units for the production server | — |
| `deploy-server.sh` | Release-symlink deploy with health gate and rollback | — |

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

## CI & releases

- Push to `main` runs **CI**: server tests + lint, macOS and iOS app builds (`.github/workflows/ci.yml`, Xcode 26.3).
- Push a tag `v*.*.*` runs **Release**: builds the unsigned macOS app and the server bundle, attaches them to a GitHub Release (`.github/workflows/release.yml`).

```sh
git tag v0.2.0 && git push origin v0.2.0
```

## Docs

- `DESIGN.md` — design system (gold palette, glassmorphism, components)
- `tasks.md` — executable improvement plan (phases, server prod state)
- `MY-WAVE-PLAN.md` — "My Wave" recommendation engine plan
