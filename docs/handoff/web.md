# Web app handoff (ws/web)

Status as of 2026-11-14. Screenshots: `docs/screenshots/2026-11-14-web-*.png`.

## What's built

- **Home shelves**: Keep reading, Recently added, one row per series. "See all" opens the
  library scoped to that shelf.
- **Library with filters**: search, author (with suggestions), published year range,
  age group (only groups at or below the reader's limit), sort. Filters live in the URL.
- **Book page**: cover, authors (link to filter), series, age group, formats. Kindle-only
  books get "Open in Kindle" (metadata-only, no DRM handling).
- **Reader** (foliate-js): EPUB, AZW3/MOBI, FB2, CBZ. Paginated or scrolling, font size,
  font (incl. dyslexia-friendly), line spacing, contents, bookmarks, position slider,
  keyboard arrows, big tap zones, hide-toolbar mode. PDF opens in the browser viewer for now.
- **Progress sync** (against [sync-api.md](../sync-api.md)): every page turn is saved on the
  device at once and sent to the server after 2s, and on tab hide/close. Positions saved
  offline go up through `POST /api/progress/batch` when the network returns. On open, the
  newest of server and device wins, with a "picked up where you left off on <device>" note.
- **Themes**: Dark, Light, Nuclear, Retro, Pink, School, Gaming, Dinosaur, Storm. Picture
  buttons, saved per profile (`PATCH /api/users/me`) and cached per device. A test keeps every
  theme at WCAG AA contrast. The book page follows the theme too.
- **Kid mode** (role `kid`): no search or filters, big covers that open straight into the
  book, star progress, two-item nav (Books, Colors), giant page-turn buttons, Barnaby
  walking along the progress bar, bigger text by default.
- **Barnaby branding**: favicon, app icon, PWA manifest, header logo, full-body Barnaby on
  empty and error states, and `BarnabyAvatar` / `BarnabySays` (with a thinking state)
  ready for the AI helper.
- **Demo mode** with sample books and a short original sample EPUB, used for screenshots.

## Running it

```
pnpm install
pnpm --filter @bookbandit/shared build
pnpm --filter @bookbandit/web demo        # sample data, no server
pnpm --filter @bookbandit/web dev         # against the server on :8080
# screenshots (needs Playwright + Chromium):
pnpm --filter @bookbandit/web build && pnpm --filter @bookbandit/web preview --port 4173 &
pnpm --filter @bookbandit/web screenshots
```

## What the server needs to provide

See `apps/web/API_CONTRACT.md`. Sync is merged. `/api/users/me` comes from the auth PR, the
shelves/books/authors endpoints from the lead, and covers/files from the library workstream.
Until those land, the real (non-demo) app shows "Barnaby can't reach the server".

## Roadmap for the web app

Next (phase 1, once the endpoints above exist):
1. Wire to the real API and fix any shape mismatches; add an end-to-end Playwright test.
2. PDF in foliate (bundle pdf.js) so PDFs get page progress and themes.
3. Highlights and notes (the `bookmarks.kind = highlight` column is ready).
4. Profile switcher and kid PIN / picture sign-in screens (with ws/auth).
5. Audiobookshelf player links for books with `absItemId`.
6. "Last read on" and finished badges, series order view, categories (tags) page.

Phase 2 (tablets):
- Offline downloads (service worker + IndexedDB) so the Android/Capacitor app can read
  without wifi; progress already queues offline.
- Storyteller mode for the youngest kids (read-aloud with TTS, picture books full screen).
- Requests UI for kids and adults, admin downloads/Shelfmark screens (admin-only).

Phase 3 (polish):
- Barnaby AI helper chat using `BarnabySays`, theme mascots per theme, discover/trending,
  cookbook view, duplicate finder UI, Kindle library import view.

## Known gaps

- Search/filters rely on the server honoring the new query params; demo mode fakes them.
- Theme fonts use local fallbacks (no webfonts bundled yet).
- No web e2e tests against a live server yet; unit tests cover filters, themes and sync.
