# End-to-end tests

Playwright tests against the real thing: the built server (`apps/server/dist`), the built web app
(`apps/web/dist`), a fresh SQLite database and real EPUB files. Nothing is mocked except the AI
model, which is a small fake OpenAI-compatible server that records what it was sent.

```sh
pnpm --filter @bookbandit/shared build
pnpm --filter @bookbandit/server build
pnpm --filter @bookbandit/web build
pnpm --filter @bookbandit/e2e exec playwright install chromium   # once
pnpm --filter @bookbandit/e2e e2e
```

`PW_CHROMIUM_PATH=/path/to/chrome` uses a Chromium you already have. `E2E_PORT` (default 18765)
moves the server; `E2E_LOG_LEVEL=info` shows its log.

## What global setup builds

[`support/global-setup.ts`](support/global-setup.ts) writes EPUBs into `.run/books` in rating
folders, starts the server on them and then sets up a family through the public API, the way a
person would: first-run admin, the startup scan, approving the inbox (except one book), Dad (parent,
password), Emma (7, PIN), a shared family tablet, e-reader sign-ins for both, Barnaby on the fake
model with Emma's AI turned on by Dad, and a series and a category that mix every rating.
The ids and tokens go to `.run/state.json` for the tests.

| Book | Rating | Emma (7) | Dad |
| --- | --- | --- | --- |
| Dragon Picnic, Moon Socks | kids | yes | yes |
| Orbit of Ashes | teen | no | yes |
| Midnight Ledger | adult | no | yes |
| Harbor of Whispers | unrated (counts as adult) | no | yes |
| Velvet Confessions | explicit | no | no (needs his own opt-in) |
| Puddle Jumpers | kids, still in the inbox | no | no (admins only) |

## The content lock, door by door

| Door | Spec |
| --- | --- |
| Web app on a tablet: picker, PIN, home, typed-in book URLs, files from the same session | `web-kid-tablet.spec.ts` |
| Web API: list, search, authors, book, file, cover, progress, bookmarks, shelves, series, categories | `lock-api.spec.ts` |
| OPDS: every feed, search, downloads, covers | `lock-ereader.spec.ts` |
| Kobo sync: library sync, downloads, metadata | `lock-ereader.spec.ts` |
| KOReader sync: positions for a locked book's document never reach the library | `lock-ereader.spec.ts` |
| Barnaby: the model never sees a locked title for a kid; book chat and "More like this" on a locked book are 404 | `lock-ai.spec.ts` |
| Discover: "popular in your family" | `lock-discover-requests.spec.ts` |
| Requests: a locked title is never "already in the library" | `lock-discover-requests.spec.ts` |

Each door also has a control (Dad's sign-in sees the adult book) so a test can't pass by
returning nothing. A new endpoint that returns books gets a line here and a check in the right spec.

Also covered: password sign-in, the Content-Security-Policy (no violations while the app and the
reader run), reading on one browser and picking up the position on another (`web-sync.spec.ts`),
and a kid not being able to change her own birth year or AI settings.

## Performance

`pnpm --filter @bookbandit/e2e perf` writes 20,000 books (`PERF_BOOKS`) straight into a fresh
database, starts the built server and times the busiest requests. It fails when a p95 goes over
`PERF_BUDGET_MS` (200). CI runs it after the end-to-end tests and puts the table in the job summary.
