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

Later phases continue in wave 2 below.

## Wave 2

Wave 1 (above) is merged and released as v0.1.0. Wave 2 runs in parallel with the auth thread's
web sign-in screen and own-profile editor (`apps/web/src/app/**` and `apps/web/src/auth/**`), so
none of these touch those paths.

| # | Workstream | Branch prefix | Owns |
| --- | --- | --- | --- |
| 7 | Admin and family UI | `ws/admin` | `apps/web/src/admin/**`, `apps/web/src/family/**`, `apps/server/src/routes/admin-*.ts` |
| 8 | Listening, Send to Kindle, storyteller | `ws/listen` | `apps/web/src/audio/**`, `apps/web/src/storyteller/**`, `apps/web/src/kindle/**`, `apps/server/src/storyteller/**` |
| 9 | Barnaby AI | `ws/ai` | `apps/server/src/ai/**`, `apps/web/src/ai/**` |
| 10 | Requests, downloads, uploads, job runner | `ws/requests` | `apps/server/src/jobs/**`, `apps/server/src/requests/**`, `apps/server/src/downloads/**`, `apps/web/src/requests/**` |
| 11 | Discover, series, categories, Kindle library | `ws/discover` | `apps/server/src/discover/**`, `apps/web/src/discover/**`, `apps/web/src/series/**` |
| 12 | Android tablet app | `ws/android` | `apps/android/**`, `.github/workflows/android.yml` |
| 13 | E-reader sync: OPDS, KOReader, Kobo | `ws/ereader` | `apps/server/src/opds/**`, `apps/server/src/koreader/**`, `apps/server/src/kobo/**` |

### Shared-file rules for wave 2

- **Web routes and nav.** Each web workstream adds its pages in its own folder and registers them
  with one small, additive edit to `apps/web/src/App.tsx` (routes) and the nav list. Don't
  restructure either; the lead resolves conflicts there.
- **Server registration.** One additive line in `apps/server/src/app.ts` per plugin, registered
  before the static fallback.
- **Schema.** New tables go in a schema file in your own folder (for example
  `apps/server/src/ai/schema.ts`), added to `drizzle.config.ts`'s schema list. One migration per PR,
  generated after merging the latest `main`.
- **Jobs.** `ws/requests` owns the generic job runner (`apps/server/src/jobs/**`, on the existing
  `jobs` table). Others enqueue through its `enqueue(type, payload)` and register handlers in their
  own folder; until it lands, run work inline and leave a `TODO(jobs)`.
- **Content lock.** Every new list, search, feed, recommendation and AI answer goes through
  `visibleBooksWhere` / `assertCanSee` with a test (CLAUDE.md rule 1). AI context and OPDS feeds
  count as "returning books".

### Wave 2 briefs

7. **Admin and family UI.** Admin pages:
   - Inbox: approve, edit metadata, set rating, merge or skip duplicates.
   - Unrated-books review queue.
   - Library scan status and a "Scan now" button.
   - Users and kids: create kids, link parents, set birth year, sign-in method, PIN/picture reset,
     paired devices.
   - Integration settings: Audiobookshelf, SMTP for Send to Kindle, metadata API keys. AI and
     downloader settings appear once those streams expose their settings APIs.
   - Parent dashboard: each kid's reading, time, pending requests, and kid AI chats (read-only).

   Uses existing server APIs, adding `admin-*.ts` routes only where something is missing. Done when
   an admin can approve and rate an inbox book, add a kid, and configure Audiobookshelf and SMTP
   entirely in the browser.
8. **Listening, Send to Kindle, storyteller.**
   - Web audiobook player on the existing Audiobookshelf API: play/pause, ±30 s, speed, chapters,
     sleep timer, listening progress sync.
   - "Send to Kindle" button on the book page, with a per-profile `@kindle.com` address setting.
   - Toddler storyteller mode: full-screen grid of 4 to 9 big covers from the kid's shelf
     (`storyteller=true`), one big play button, sleep timer, and a nightly limit (stories or
     minutes) set by a parent and enforced on the server, ending with Barnaby's goodnight screen.
     Text-to-speech fallback for picture books with no audio.

   Done when a toddler profile plays a story, the nightly limit stops the next one, and an EPUB
   reaches a Kindle from the button.
9. **Barnaby AI.**
   - Provider layer: OpenAI-compatible (Ollama, LM Studio, llama.cpp), Anthropic, Gemini, with a
     provider chosen per feature, admin settings API, and a usage log.
   - SearXNG web search with sources.
   - Moderation on input and output.
   - Adult chat with Barnaby as the avatar.
   - Kid AI mode: age-level answers; stays within the content lock; web search off unless a parent
     enables it, and then only SearXNG safe search with an allowlist; strips personal details;
     every message logged to `ai_messages`; daily limits; no chat under 5.
   - Spoiler-free book chat using only text up to the reader's position.
   - Admin rating helper that suggests a rating for unrated books.

   Done when an adult and a kid can chat with Barnaby through a local Ollama, kid chats appear in the
   parent log API, and the rating helper fills the review queue.
10. **Requests, downloads, uploads, job runner.**
    - Generic job runner on the `jobs` table: retries, backoff, status API.
    - Book requests: anyone can request. A kid's request above their rating is auto-declined. A
      parent or admin approves.
    - Downloader clients: Shelfmark and sabnzbd, plus a direct URL downloader into
      `/books/_incoming`. All admin-only, with logs.
    - Browser uploads (admin, and adults if allowed) into the inbox.
    - Request UI: "Request this book" from search and Discover, and "My requests".

    Done when a request goes from kid → parent approval → Shelfmark → a file in the inbox.
11. **Discover, series, categories, Kindle library.**
    - Discover page with trending and popular lists from Hardcover and Open Library, each book
      marked In library, On Kindle, or Request it (this calls `ws/requests` once it lands).
    - Series pages in reading order.
    - Admin-created and edited series (drag to reorder).
    - Category/tag browsing.
    - Cookbook view: keep the screen awake, larger text, jump to a recipe.
    - Kindle library import as metadata-only `kindle_only` books, from a CSV/export, with a "Read in
      Kindle" link.

    Done when trending shows library and Kindle badges, a series page lists books in order, and a
    Kindle CSV import creates browsable entries.
12. **Android tablet app.**
    - Capacitor app wrapping `apps/web` with server URL setup and QR pairing (the claim API
      already exists).
    - Offline downloads with file storage and the progress batch upload.
    - Screen pinning for storyteller mode.
    - Kid-safe settings lock.
    - Signed debug APK built in CI.

    Done when a sideloaded APK on an Android tablet (including Fire tablets) pairs by QR, downloads a
    book, reads it offline, and syncs progress when back online.
13. **E-reader sync: OPDS, KOReader, Kobo.**
    - OPDS 1.2 catalog with device-token or basic auth, filtered by the content lock.
    - KOReader kosync-compatible progress server, mapped to `reading_progress`.
    - Kobo store-sync emulation (library sync, KEPUB via kepubify, reading state).

    Done when KOReader on an e-ink device syncs progress with the web reader and a Kobo shows the
    library.

## Every PR

- **Screenshots.** Any PR that changes something a person can see (web app, reader, Android app,
  admin screens, Docker first-run page) adds screenshots to `docs/screenshots/`
  (`YYYY-MM-DD-<area>-<what>.png`) and embeds them in the PR description. Capture with Playwright at
  a desktop width and a tablet width (for example 1280×800 and 800×1280).
- **Roadmap.** Tick the matching item in [ROADMAP.md](ROADMAP.md) when it's done.
- **Handoff.** Add a row to "Recent changes" in [HANDOFF.md](HANDOFF.md), and update "How to run"
  or "Next up" if your change affects them.
