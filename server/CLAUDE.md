---
description: Server conventions (Bun, not Node/npm/Vite)
globs: "*.ts, *.tsx, *.js, package.json"
alwaysApply: false
---

Project-wide rules live in the repository root `AGENTS.md`.

- Use Bun: `bun install`, `bun run <script>`, `bun test`, `bunx` — not node, npm, pnpm, yarn or vite.
- Use Bun built-ins where they fit: `bun:sqlite`, `Bun.file`, `Bun.CryptoHasher`, `Bun.serve`; Bun loads `.env` itself (no dotenv).
- HTTP routes are Hono 4 routers mounted from the app module; tests call `app.request(...)`.
- Before committing: `bun run typecheck && bun test src/__tests__ && bun run lint`.
