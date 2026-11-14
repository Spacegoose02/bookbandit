# Workstreams

Parallel work is split by area so branches rarely touch the same files. The lead keeps
`main`, the schema core (`apps/server/src/db/schema.ts`), `packages/shared` and `apps/server/src/app.ts`
consistent; other workstreams may make small additive edits there and call them out in the PR.

| # | Workstream | Branch prefix | Owns |
| --- | --- | --- | --- |
| 1 | Library ingest and metadata | `ws/library` | `apps/server/src/library/**`, `apps/server/src/metadata/**` |
| 2 | Family accounts and auth | `ws/auth` | `apps/server/src/auth/**`, `apps/server/src/routes/users.ts`, `routes/devices.ts` |
| 3 | Reading sync API | `ws/sync` | `apps/server/src/routes/progress.ts`, `routes/bookmarks.ts`, `routes/shelves.ts` |
| 4 | Web app and reader | `ws/web` | `apps/web/**` |
| 5 | Docker, Unraid and CI | `ws/docker` | `Dockerfile`, `docker/**`, `.github/**`, static serving in the server |
| 6 | Audiobookshelf and Send to Kindle | `ws/integrations` | `apps/server/src/integrations/**` |

## Briefs

1. **Library ingest and metadata.** Scan `/books`, hash files, read EPUB/PDF/CBZ metadata, look up
   Open Library, Google Books and Hardcover, set ratings from Google's mature flag, genres, keywords
   and `/books/adult`, inbox approval API, basic duplicate detection. Done when a folder of real
   books becomes approved, rated, searchable entries.
2. **Family accounts and auth.** Parent-linked kid accounts, kid PIN/picture sign-in, QR device
   pairing tokens, local password fallback, users and parent-links API with parent-only edits, dev
   seed. Done when a parent can add a kid and that kid can sign in on a paired tablet.
3. **Reading sync API.** Progress with newest-wins, bookmarks/highlights/stickers with an
   `updated_at` cursor for incremental sync, Continue reading and kid shelves; everything through the
   content lock. Done when two clients converge on the same position and bookmarks.
4. **Web app and reader.** Shelves, filters, series, kids section, foliate-js reader with progress
   sync, theme system, kid mode UI, Barnaby branding. Done when a kid can find and read a book in the
   browser and resume it elsewhere.
5. **Docker, Unraid and CI.** Serve the web build from the server, add Calibre `ebook-convert` and
   kepubify, PUID/PGID, multi-arch image on GHCR, Unraid Community Apps template. Done when the
   template installs and runs on Unraid with `/config` and `/books`.
6. **Audiobookshelf and Send to Kindle.** ABS API client to link and play audiobooks with listening
   progress sync; SMTP Send to Kindle for EPUB/PDF with per-profile addresses. Done when an audiobook
   plays in the web app and an EPUB arrives on a Kindle.

Later phases (Android app, Shelfmark/downloaders, AI, Kobo/KOReader/OPDS) start after these land.

## Every PR

- **Screenshots.** Any PR that changes something a person can see (web app, reader, Android app,
  admin screens, Docker first-run page) adds screenshots to `docs/screenshots/`
  (`YYYY-MM-DD-<area>-<what>.png`) and embeds them in the PR description. Capture with Playwright at
  a desktop width and a tablet width (for example 1280×800 and 800×1280).
- **Roadmap.** Tick the matching item in [ROADMAP.md](ROADMAP.md) when it's done.
- **Handoff.** Add a row to "Recent changes" in [HANDOFF.md](HANDOFF.md), and update "How to run"
  or "Next up" if your change affects them.
