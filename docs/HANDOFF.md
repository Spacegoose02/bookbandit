# Handoff

Where things stand, how to run it, and what's next. Update this file whenever a PR changes any of
those. Newest entries at the top of "Recent changes".

## Current state

Phase 1 is in progress. `main` has the foundation: monorepo, data model, content lock, Tinyauth
header auth, and a placeholder web page. Six workstreams are running in parallel (see
[workstreams.md](workstreams.md)); progress is tracked in [ROADMAP.md](ROADMAP.md).

Nothing is usable against a real library yet.

## How to run

```sh
corepack enable
pnpm install
pnpm --filter @bookbandit/shared build
pnpm test
pnpm dev   # API http://localhost:8080, web http://localhost:5173
```

Local auth: the API only trusts the Tinyauth email header from `TRUSTED_PROXIES`. For local
development set `TRUSTED_PROXIES=127.0.0.1` and send `Remote-Email: you@example.com`, after adding a
matching row to `user_identities`. (The auth workstream will add a dev seed and local login.)

Data lives in `./data/config` (SQLite) and `./data/books` unless `CONFIG_DIR` / `BOOKS_DIR` are set.

## Recent changes

| Date | Change | PR |
| --- | --- | --- |
| 2026-11-13 | Roadmap, handoff and screenshot rules added | this PR |
| 2026-11-13 | Foundation: monorepo, data model, content lock, Tinyauth auth, CI | first commit |

## Next up

1. Land the six Phase 1 workstreams.
2. Integration pass: wire the web app to auth, library and sync; first end-to-end run in Docker on Unraid.
3. Start Phase 2 with the Android app and storyteller mode.

## Decisions so far

- TypeScript monorepo; Fastify + SQLite (Drizzle); React + Vite; foliate-js reader; Capacitor for Android.
- Content lock is enforced on the server; unrated books count as adult; explicit needs an adult's own opt-in.
- No DRM removal. Kindle purchases are metadata-only entries that open the Kindle app.
- Barnaby the raccoon is the mascot, logo and AI chat avatar.
- AI is optional, per-feature provider (local Ollama or cloud), kid AI logged for parents.
