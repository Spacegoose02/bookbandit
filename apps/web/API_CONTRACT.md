# Web app ⇄ server API contract

What `apps/web` calls (`src/api/client.ts`), and who provides it. Every endpoint that returns
books uses `visibleBooksWhere` / `assertCanSee` (CLAUDE.md rule 1); locked books are 404.
Web-side types: `apps/web/src/api/types.ts`. Shared types: `@bookbandit/shared`.

| Method | Path | Provided by | Notes |
| --- | --- | --- | --- |
| GET | `/api/users/me` | ws/auth (PR #5) | `id, displayName, role, avatar, theme, birthYear, explicitOptIn`. The web app derives `isKid` from `role` and `maxRating` with `maxAllowedRating()` (`toMe` in client.ts). |
| PATCH | `/api/users/me` | ws/auth (PR #5) | `{ theme }`. Theme ids: `THEME_IDS` / `isThemeId` in shared. |
| GET | `/api/shelves` | lead | `{ items: Shelf[] }`. Shelf ids `continue`, `recent`, `kid`, `series:<id>`, `collection:<id>`, `tag:<id>`; each id also works as `?shelf=` on `/api/books`. |
| GET | `/api/books` | lead | Query `q, author, yearFrom, yearTo, ratings` (comma list, intersected with the reader's allowed ratings), `shelf, sort` (`title, author, year, added`), `limit, offset`. Returns `total`; rows include `authors`, `series`, `percent`. |
| GET | `/api/books/:id` | lead | Adds `authors`, `series`, `files: {id, format, sizeBytes}[]`, `percent`. |
| GET | `/api/authors?q=&limit=` | lead | `{ items: {id, name}[] }`, only authors with a book the reader can see. |
| GET | `/api/books/:id/cover` | ws/library | Image bytes, same lock check. |
| GET | `/api/books/:id/files/:fileId` | ws/library | The book file, same lock check, `Range` support, never DRM'd Kindle files (rule 5). |
| GET | `/api/progress/:bookId` | ws/sync, merged | `{ progress: ProgressRecord \| null }`. See [docs/sync-api.md](../../docs/sync-api.md). |
| PUT | `/api/progress/:bookId` | ws/sync, merged | `{ locator, updatedAt, deviceName, percent?, finished? }` → `{ status: "applied" \| "stale", progress }`. Sent with `keepalive` on tab hide. |
| POST | `/api/progress/batch` | ws/sync, merged | Offline queue upload on start-up and when the network returns. |
| GET | `/api/books/:bookId/bookmarks` | ws/sync, merged | `{ items: BookmarkRecord[] }` |
| POST | `/api/bookmarks` | ws/sync, merged | The web app sends its own UUID `id`, so a retry can't duplicate. |
| DELETE | `/api/bookmarks/:id` | ws/sync, merged | Soft delete. |

## Locators

Reflowable books (EPUB, AZW3, MOBI, FB2) and CBZ save `{ kind: "epub", cfi, percent }`.
PDF opens in the browser's own viewer for now and doesn't report a position yet.

## Demo mode

`pnpm --filter @bookbandit/web demo` (or `?demo`, `?demo=kid` in the URL) swaps the HTTP
client for `src/api/demo.ts`, which follows the same shapes with sample data.
