# Handoff

Where things stand, how to run it, and what's next. Update this file whenever a PR changes any of
those. Change logs live in [changes/](changes/README.md), one file per workstream.

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
URL for kid mode; the demo grown-up is an admin, so `/admin` and `/family` work too). Screenshots: build, `pnpm --filter @bookbandit/web preview --port 4173`, then
`pnpm --filter @bookbandit/web screenshots`.

Sign-in: on an empty database the web app shows "Welcome to BookBandit" and the first person creates
the admin with a username and password. After that, grown-ups sign in with username/password, or
with Google through Tinyauth (the email header is trusted only from `TRUSTED_PROXIES`; set
`GOOGLE_SIGN_IN_URL` to show a Google button). Paired tablets show "Who's reading?" and kids sign in
with a PIN or pictures. API details: `apps/server/src/auth/` and `apps/web/API_CONTRACT.md`.

E-readers (OPDS apps, KOReader, Kobo): create a sign-in under **E-readers** in the web app. The
reverse proxy must let `/opds`, `/kosync` and `/kobo` through without Tinyauth; the e-reader signs
in to Bookbandit itself. Setup steps: `apps/server/src/ereader/README.md`.

Barnaby AI is optional and off until an admin adds a provider at `/barnaby/settings`; local Ollama, cloud
providers, SearXNG web search and kid mode are set up as described in [ai.md](ai.md).

Data lives in `./data/config` (SQLite) and `./data/books` unless `CONFIG_DIR` / `BOOKS_DIR` are set.
Audiobook folders are read from `./data/audiobooks` (`AUDIOBOOKS_DIR`, `/audiobooks` in Docker), scanned at
startup with the library and from **Admin → Audiobooks**; per-person Audiobookshelf accounts, import and
write-back are on the same page. Details: `apps/server/src/audio/README.md`.

Library scanning: the server scans `BOOKS_DIR` once when it starts listening (set
`LIBRARY_SCAN_ON_START=false` to turn that off; a missing or empty folder is skipped). An admin can
start another scan with `POST /api/admin/library/scan` and check progress with `GET` on the same path.
New books wait in the admin inbox (`/api/admin/inbox`) until approved. Online metadata lookup is on
by default (`METADATA_ONLINE=false` turns it off); `HARDCOVER_API_TOKEN` and `GOOGLE_BOOKS_API_KEY`
are optional. Details: `apps/server/src/library/README.md`.

Discover pulls Open Library trending lists (and Hardcover's when a Hardcover token is set, in the
admin settings or `HARDCOVER_API_TOKEN`), cached in memory for 6 hours; turning online lookups off
turns the outside lists off. An admin imports a Kindle library at `/discover/kindle-import` (or
`POST /api/admin/kindle/import`). Demo mode has an admin persona too: `?demo=admin`. See
[discover-api.md](discover-api.md).

Android tablet app: `pnpm --filter @bookbandit/web build && pnpm --filter @bookbandit/android build`,
then `cap sync android` and `./gradlew assembleDebug` (JDK 21 + Android SDK). CI builds the APK on
every PR and attaches it to releases. Details and signing: [apps/android/README.md](../apps/android/README.md).

## Recent changes

Each workstream keeps its own change log in [changes/](changes/README.md), newest first, so
parallel PRs don't fight over one table: [lead](changes/lead.md), [auth](changes/auth.md),
[web](changes/web.md), [library](changes/library.md), [sync](changes/sync.md),
[integrations](changes/integrations.md), [docker](changes/docker.md), plus a file per wave 2
workstream once it lands. Add your entry there, not here.
| Date | Change | PR |
| --- | --- | --- |
| 2026-11-14 | Admin and family UI: `/admin` (overview + scan, inbox with bulk approve, rating, metadata edit, merge, reject; needs-a-rating queue; people, kids and paired devices; Audiobookshelf, SMTP and metadata-lookup settings) and `/family` (per-kid reading, requests and read-only Barnaby chats). New APIs in `routes/admin-library.ts`, `admin-settings.ts`, `admin-family.ts`; see [admin-api.md](admin-api.md). Metadata API keys can now be set in the browser and apply without a restart | ws/admin PR |
| 2026-11-14 | Sign-in screens: first-run admin setup, username/password, Google button (`GOOGLE_SIGN_IN_URL`), tablet pairing by code, "Who's reading?" with kid PIN and picture pads, Settings → your name and kids' names, Switch reader / Sign out. Tablet browsers keep the device token in a `bb_device` cookie | this PR |
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

1. Wave 3 in parallel (see [workstreams.md](workstreams.md#wave-3)): own the audio, move in from
   Calibre/Calibre-Web/Kavita, librarian tools, Barnaby AI round 2, read-aloud and learning, kids'
   goals and rewards, ops (backups, end-to-end tests, hardening, v0.2.0). Next migration number is
   0008; see [Migrations in wave 3](workstreams.md#migrations-in-wave-3).
2. Lead: reader hooks for read-aloud and kids, integration passes as wave 3 lands.
3. Owner: real-device checks (Fire/Android tablet, Windows PC, Kobo, KOReader).

## Decisions so far

- TypeScript monorepo; Fastify + SQLite (Drizzle); React + Vite; foliate-js reader; Capacitor for Android.
- Content lock is enforced on the server; unrated books count as adult; explicit needs an adult's own opt-in.
- No DRM removal. Kindle purchases are metadata-only entries that open the Kindle app.
- Barnaby the raccoon is the mascot, logo and AI chat avatar.
- AI is optional, per-feature provider (local Ollama or cloud), kid AI logged for parents.
