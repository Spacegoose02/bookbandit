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
- **Styles.** Put a new area's CSS in its own file next to its components (for example
  `apps/web/src/admin/admin.css`, imported by that area's page) instead of appending to
  `apps/web/src/styles.css`. Use the theme variables from `styles.css`; only change shared rules
  there when you must.
- **Docs.** Change log entries go in your own `docs/changes/<workstream>.md`, never in a shared
  table (see [Every PR](#every-pr)).

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

## Wave 3

Wave 2 is merged (PRs #13 to #30). Wave 3 finishes the "replace Calibre, Calibre-Web and Kavita"
goal, starts owning the audio, and polishes the kids' side. The shared-file rules from wave 2 still
apply, and so does [Every PR](#every-pr).

| # | Workstream | Branch prefix | Owns |
| --- | --- | --- | --- |
| 14 | Own the audio | `ws/audio` | `apps/server/src/audio/**`, `apps/server/src/integrations/audiobookshelf/**`, `apps/web/src/audio/**` |
| 15 | Move in from Calibre, Calibre-Web, Kavita and others | `ws/migrate` | `apps/server/src/imports/**`, `apps/server/src/metadata/providers/isbndb.ts`, `apps/web/src/imports/**` |
| 16 | Librarian tools | `ws/librarian` | `apps/server/src/librarian/**`, `apps/web/src/librarian/**` |
| 17 | Barnaby AI, round 2 | `ws/ai` | `apps/server/src/ai/**`, `apps/web/src/ai/**` |
| 18 | Read-aloud and learning | `ws/readaloud` | `apps/server/src/narration/**`, `apps/server/src/learning/**`, `apps/web/src/readaloud/**` |
| 19 | Kids: goals, rewards, polish | `ws/kids` | `apps/web/src/kid/**`, `apps/web/src/themes/**`, `apps/server/src/rewards/**` |
| 20 | Ops: backups, end-to-end tests, hardening, release | `ws/ops` | `e2e/**`, `apps/server/src/backup/**`, `docker/**`, `.github/workflows/ci.yml`, `.github/workflows/docker.yml` |

The lead keeps the reader (`apps/web/src/reader/**`), the catalog and sync routes, and the
integration passes. `ws/readaloud` and `ws/kids` need small hooks in the reader (a toolbar button,
a "finished a chapter" event); ask the lead through the coordinator, or add one clearly marked,
additive line and say so in the PR.

### Migrations in wave 3

`main` is at `0007_requests_jobs`, so the next free number is **0008**. Several wave 3 streams add
tables (audio, migrate, librarian, ai, readaloud, kids), and the number goes to whoever merges first.

- Put your tables in your own schema file and add it to `drizzle.config.ts`'s schema list.
- Generate the migration **last**, right before you mark the PR ready, after merging the latest
  `main`. Name it after your area: `npx drizzle-kit generate --name <area>`.
- When `main` moves and your PR then conflicts in `apps/server/drizzle/meta/_journal.json`, delete
  your migration SQL and snapshot, take `main`'s `meta/`, and generate again. Never hand-edit
  numbers or reuse a number that is on `main`.
- Additive changes only: new tables or new nullable columns. A column on a core table
  (`apps/server/src/db/schema.ts`) needs the lead's OK first.

### Wave 3 briefs

14. **Own the audio.** Phase 4: Audiobookshelf can be switched off.
    - Audiobook folder scan of `AUDIOBOOKS_DIR` (default `/audiobooks`): one folder per book
      (MP3/M4B/M4A/OGG/FLAC), chapters from M4B atoms or file names, cover and metadata from tags
      plus the existing lookup, linked to the ebook of the same work when ISBN or title and author
      match. Same content lock and inbox approval as ebooks.
    - Serve local audio with Range, through the same `/api/books/:id/audio` shape the web player
      already uses, so the player works for both sources.
    - Audiobookshelf position write-back: when someone listens in Bookbandit, push the position to
      ABS (newest wins) so both stay in step while the family still uses ABS apps.
    - "Import from Audiobookshelf": per-user progress, finished flags and bookmarks.
    - Player: per-book speed memory, skip silence (optional), bookmarks with notes.

    Done when an audiobook folder with no Audiobookshelf plays in the web player and on a tablet,
    and positions from an ABS account show up in Bookbandit after the import.
15. **Move in from Calibre, Calibre-Web, Kavita and others.** One "Import" page for admins.
    - Calibre `metadata.db`: titles, authors, series and index, tags, identifiers, publishers,
      languages, descriptions and covers, matched to scanned files by path or hash. Files stay
      where they are; nothing is moved or rewritten.
    - Calibre-Web `app.db`: per-user read status, shelves (to collections) and Kobo sync state;
      admin maps each Calibre-Web user to a Bookbandit person.
    - Kavita: read progress and collections through its API (URL and API key), mapped per person.
    - Goodreads and StoryGraph CSV: read status, dates and ratings as reading history; export the
      same format back.
    - Google Play Books: library list as metadata-only entries, like the Kindle import.
    - ISBNdb as another optional metadata provider (API key in settings).
    - Every import shows a dry-run report (matched, new, skipped, conflicts) before writing, and
      runs on the job runner.

    Done when a real Calibre library and a Calibre-Web `app.db` import with series, tags and each
    person's read status, and a Goodreads CSV round-trips.
16. **Librarian tools.** What Calibre's desktop app still does for the family.
    - Library-wide duplicates page (the library service already detects them): side by side,
      keep, merge formats into one book, or ignore.
    - Bulk edit: select many books, set series, tags, rating, author or language.
    - Convert formats on the job runner with `ebook-convert` (MOBI/AZW3/FB2 to EPUB, EPUB to
      KEPUB ahead of time, which also clears the `TODO(jobs)` in `apps/server/src/kobo/kepub.ts`
      and `apps/server/src/ereader/README.md`). Converted files go next to the original under `/books`.
    - Optional "write metadata into the file" for EPUB (off by default, never for DRM files).
    - Cover editor: pick from lookup results, upload, or crop.
    - Library health: missing files, unreadable files, books with no cover, no rating, no author.

    Done when an admin merges two duplicates, bulk-sets a series on ten books, and converts a MOBI to
    an EPUB that opens in the reader. Adds a "Librarian" link to the admin nav with one additive line.
17. **Barnaby AI, round 2.** Builds on [ai.md](ai.md).
    - AI metadata cleanup: suggest fixed titles, author names, series and descriptions; admin
      accepts per field.
    - "More like this" on the book page and smart requests ("something like Pixel Quest for a
      10-year-old"), both through the content lock and the kid's rating.
    - Meaning search with embeddings (local model through Ollama, stored in SQLite), merged into
      library search.
    - Streaming replies in chat.
    - Move the rating helper onto the job runner (`TODO(jobs)` in `apps/server/src/ai/rating.ts`).

    Done when "more like this" works on a kid profile without crossing their limit, and a
    meaning search finds a book by its plot.
18. **Read-aloud and learning.**
    - Narration with a local TTS server (Kokoro-FastAPI or Piper through an OpenAI-compatible
      `/v1/audio/speech`), with the voice chosen per person. Caches audio per chapter. The reader highlights each
      sentence as it is read.
    - Read-along for EPUB3 media overlays when the book has them.
    - Word help: tap a word for a kid-friendly meaning and "say it" (offline dictionary first,
      AI in kid mode if enabled).
    - Quizzes: three short questions after a chapter, made from the text the kid has read, logged
      for parents; Barnaby cheers.
    - Storyteller uses narration for picture books that have no audiobook.

    Done when a 7-year-old's profile can have a chapter read aloud with highlighting, tap a word for
    its meaning, and answer a quiz that shows up on the family dashboard.
19. **Kids: goals, rewards, polish.**
    - Reading goals set by a parent (minutes a day or books a month) on top of the reading-time API.
    - Barnaby badges and a sticker book for streaks, finished books and goals; celebrations that
      don't interrupt reading.
    - Kid home refresh: big "keep reading", a goal ring, "new on my shelf", age-group rows.
    - Reading bedtime for all kid profiles (not only storyteller), enforced on the server.
    - Theme pass: every page from wave 2 (Discover, requests, AI, audio, admin) checked in all
      themes, with fixes; high-contrast and dyslexia-friendly font options in the reader settings.

    Done when a kid earns a badge for a goal set by a parent, sees it on the kid home, and every
    theme looks right on the wave 2 pages (screenshots in the PR).
20. **Ops: backups, end-to-end tests, hardening, release.**
    - Nightly SQLite backup to `/config/backups` (keep N), plus a restore command and an admin
      "Back up now" button; documented in the Unraid notes.
    - Playwright end-to-end suite in CI: sign in, read and sync between two browsers, and the
      content lock from every door (web, OPDS, Kobo, KOReader, AI, Discover, requests).
    - Hardening: rate limits on password and PIN sign-in, session and device-token expiry,
      security headers, a dependency audit in CI.
    - Performance: a 20,000-book test library; list, search and shelves under 200 ms.
    - Release v0.2.0: changelog from `docs/changes/`, Unraid template and Docker README update.

    Done when CI runs the end-to-end suite green, a backup restores into a fresh container, and
    v0.2.0 is released.

### Owner checks (not a workstream)

These need real hardware, so they stay on the roadmap until someone tries them:

- Android app on a Fire tablet and an Android tablet (pair, download, read offline, sync).
- Windows desktop app on a real PC.
- A physical Kobo and KOReader device against the server.

## Every PR

- **Screenshots.** Any PR that changes something a person can see (web app, reader, Android app,
  admin screens, Docker first-run page) adds screenshots to `docs/screenshots/`
  (`YYYY-MM-DD-<area>-<what>.png`) and embeds them in the PR description. Capture with Playwright at
  a desktop width and a tablet width (for example 1280×800 and 800×1280).
- **Roadmap.** Tick the matching item in [ROADMAP.md](ROADMAP.md) when it's done. Edit only your
  own items and keep the blank line between items.
- **Change log.** Add a bullet at the top of `docs/changes/<workstream>.md` (create it if your
  workstream has none; see [changes/README.md](changes/README.md)). Don't add rows to HANDOFF.md.
- **Handoff.** Update "How to run" in [HANDOFF.md](HANDOFF.md) only if your change affects it
  (new env vars, new services). The lead keeps "Next up" and "Decisions".
- **Stay mergeable.** You own your PR until it merges, conflicts included. Check it right after
  every push and again whenever `main` moves (another PR merged):

  ```sh
  gh api repos/spacegoose02/bookbandit/pulls/<N> --jq '.mergeable_state'
  ```

  `dirty` means conflicts. Then merge the latest `main` into your branch (don't rebase a branch
  others may have pulled), resolve every conflict keeping both sides' intent, regenerate your
  migration if `main` added one so numbering stays linear, run `pnpm typecheck` and `pnpm test`,
  and push. `unknown` means GitHub is still computing; ask again shortly. Don't wait for the lead
  or the owner to fix conflicts on your PR.
