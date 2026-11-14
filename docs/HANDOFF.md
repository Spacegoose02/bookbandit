# Handoff

Where things stand, how to run it, and what's next. Update this file whenever a PR changes any of
those. Newest entries at the top of "Recent changes".

This file is written so an agent or developer with only this repository can pick up any
piece of work. You don't need access to any outside chat or document.

## Picking up work

1. Read [CLAUDE.md](../CLAUDE.md) (rules that must never break, conventions).
2. Read [architecture.md](architecture.md) (the plan) and [ROADMAP.md](ROADMAP.md) (what's done).
3. Pick an unchecked roadmap item. Its workstream, branch prefix, owned files and detailed brief
   are in [workstreams.md](workstreams.md).
4. Check open pull requests and branches with that prefix first, so you don't redo work in flight.
5. Branch from `main` (`ws/<area>-<short-topic>`), keep to your area, run `pnpm typecheck` and
   `pnpm test`, add screenshots for UI changes, tick the roadmap, add a row below, open a PR.

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

Web UI without a server: `pnpm --filter @bookbandit/web demo` (sample books; add `?demo=kid` to the
URL for kid mode). Screenshots: build, `pnpm --filter @bookbandit/web preview --port 4173`, then
`pnpm --filter @bookbandit/web screenshots`.

Local auth: the API only trusts the Tinyauth email header from `TRUSTED_PROXIES`. For local
development set `TRUSTED_PROXIES=127.0.0.1` and send `Remote-Email: you@example.com`, after adding a
matching row to `user_identities`. (The auth workstream will add a dev seed and local login.)

Data lives in `./data/config` (SQLite) and `./data/books` unless `CONFIG_DIR` / `BOOKS_DIR` are set.

Library scanning: the server scans `BOOKS_DIR` once when it starts listening (set
`LIBRARY_SCAN_ON_START=false` to turn that off; a missing or empty folder is skipped). An admin can
start another scan with `POST /api/admin/library/scan` and check progress with `GET` on the same path.
New books wait in the admin inbox (`/api/admin/inbox`) until approved. Online metadata lookup is on
by default (`METADATA_ONLINE=false` turns it off); `HARDCOVER_API_TOKEN` and `GOOGLE_BOOKS_API_KEY`
are optional. Details: `apps/server/src/library/README.md`.

## Recent changes

| Date | Change | PR |
| --- | --- | --- |
| 2026-11-14 | PDF reader on pdf.js: page-by-page view, page progress sync, page bookmarks; demo PDF | lead |
| 2026-11-14 | Wave 2 workstreams planned (admin, listening/storyteller, AI, requests/downloads, discover, Android, e-reader sync) | lead |
| 2026-11-14 | Library: scan `/books` (hashes, moves, duplicates), EPUB/PDF/CBZ metadata, Hardcover/Google Books/Open Library lookup, automatic ratings (folders, Google mature flag, ComicInfo, genres), admin inbox, cover and file serving with Range and DRM refusal, scan at startup (see `apps/server/src/library/README.md`) | #7 |
| 2026-11-14 | Web app: shelves, library filters, book page, foliate reader with progress sync and bookmarks (against the sync API), 9 themes, kid mode, Barnaby branding, demo mode. Endpoints it calls: [apps/web/API_CONTRACT.md](../apps/web/API_CONTRACT.md); details and web roadmap: [handoff/web.md](handoff/web.md) | #6 |
| 2026-11-14 | Catalog API: book filters/search/sort/total, richer book details, authors, home shelves ([catalog-api.md](catalog-api.md)) | lead |
| 2026-11-14 | Audiobookshelf playback/progress API and Send to Kindle API (see `apps/server/src/integrations/README.md`) | ws/integrations PR |
| 2026-11-14 | Reading sync API: progress (newest wins, offline batch), bookmarks/highlights/stickers with `updated_at` sync cursor (migration 0001), Continue reading, Finished and kid shelves; see [sync-api.md](sync-api.md) | this PR |
| 2026-11-13 | Roadmap, handoff and screenshot rules added | this PR |
| 2026-11-13 | Foundation: monorepo, data model, content lock, Tinyauth auth, CI | first commit |

## Next up

1. Wave 2 in parallel (see [workstreams.md](workstreams.md#wave-2)): admin and family UI, listening and
   storyteller, Barnaby AI, requests and downloads, Discover, Android app, e-reader sync.
2. Auth: web sign-in screen and own-profile editor.
3. Lead: PDF reading progress, integration passes as wave 2 lands, release v0.2.0.

## Decisions so far

- TypeScript monorepo; Fastify + SQLite (Drizzle); React + Vite; foliate-js reader; Capacitor for Android.
- Content lock is enforced on the server; unrated books count as adult; explicit needs an adult's own opt-in.
- No DRM removal. Kindle purchases are metadata-only entries that open the Kindle app.
- Barnaby the raccoon is the mascot, logo and AI chat avatar.
- AI is optional, per-feature provider (local Ollama or cloud), kid AI logged for parents.
