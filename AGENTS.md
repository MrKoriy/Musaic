# Musaic — working rules

Personal, single-user self-hosted music service: Bun + Hono 4 + `bun:sqlite`
server (`server/`), optional Python media sidecar (`server/sidecar/`), SwiftUI
clients (`MusaicApp/`: iOS 17+, macOS 15+, watchOS 9+, widget + Live Activity).

## Checks before every commit

```sh
cd server && bun run typecheck && bun test src/__tests__ && bun run lint
cd server/sidecar && python3 -m unittest discover -s tests      # sidecar changes
cd MusaicApp && xcodegen generate && xcodebuild -scheme Musaic -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
cd MusaicApp && xcodebuild test -scheme MusaicMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO   # Swift unit tests (Tests/)
```

CI (`.github/workflows/ci.yml`) runs the same plus macOS Debug/Release, watchOS,
Swift unit tests, ShellCheck and actionlint. It builds with Xcode 26.6: iOS 27
APIs only behind `#if compiler(>=6.3)` / `if #available(iOS 27, macOS 27, *)`.

## Server

- Migrations are append-only. Core schema: `server/src/db/migrations.ts`
  (versions 1–39). Recommendation/provider schema: `server/src/db/migrations-reco.ts`
  (versions 40+). Never edit an applied migration.
- Work that must survive a restart goes through the durable task queue
  (`server/src/jobs/tasks.ts`), not an in-memory Map.
- Auth is deny-by-default: every `/api/*` and `/audio/*` route needs a session
  except the explicit public list in the auth middleware.
- Streams: `stream/promises` `pipeline`, temp file + rename, one Range parser
  (`server/src/utils/stream-proxy.ts`).
- The AI assistant uses B.ai (`server/src/reco/chat.ts`) — keep that config.

## Clients

- The Xcode project is generated: edit `MusaicApp/project.yml`, never
  `Musaic.xcodeproj` (it is not committed). New files under `Models/`,
  `Services/`, `Stores/`, `Views/`, `Widgets/`, `WatchApp/`, `Tests/` are picked
  up on the next `xcodegen generate`. Unit tests use Swift Testing and
  `@testable import MusaicMac`.
- Swift 6 with `SWIFT_STRICT_CONCURRENCY=complete` on every target.
- API contract: don't break an endpoint without updating
  `MusaicApp/Services/APIService.swift` in the same branch.
- Palette is gold (`#e6d8c3` / `#cdb69a` / `#090807`, tokens at the end of
  `MusaicApp/MusaicApp.swift`, spec in `DESIGN.md`). The retired pink `#e91e8c`
  must not return. The app is dark-only.
- New UI strings go into `Resources/Localizable.xcstrings` with `en` and `ru`.
- Animations respect Reduce Motion; controls have accessibility labels; text
  uses Dynamic Type-aware fonts.

## Docs

`DESIGN.md` (design system), `MY-WAVE-PLAN.md` (recommendations), `RESEARCH.md`
(research notes), `tasks.md` (backlog).
