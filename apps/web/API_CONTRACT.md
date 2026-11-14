# Web app ⇄ server API contract

What `apps/web` calls today (`src/api/client.ts`). The server workstreams own the endpoints;
this file is the web side's ask so the two can meet. Anything marked **new** doesn't exist on
`main` yet. Every endpoint that returns books must use `visibleBooksWhere` / `assertCanSee`
(CLAUDE.md rule 1); locked books are 404. Types are in `apps/web/src/api/types.ts`.

| Method | Path | Owner | Status | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/me` | ws/auth | **new** | `Me`: `id, displayName, role, isKid, avatar, theme, maxRating` |
| PATCH | `/api/me` | ws/auth | **new** | `{ theme }`, validate with `isThemeId` from shared. Kids may change their own theme (it isn't a limit). |
| GET | `/api/shelves` | ws/sync | **new** | `{ items: Shelf[] }`. Kinds: `continue`, `kid` (from `kid_shelf`), `recent`, `series`, `collection`, `tag`. Each shelf's `id` must also work as `?shelf=` on `/api/books`. |
| GET | `/api/books` | lead / ws/library | exists, needs params | Add query params: `q`, `author`, `yearFrom`, `yearTo`, `ratings` (comma list, intersected with the reader's allowed ratings), `shelf`, `sort` (`title`, `author`, `year`, `added`). Return `total`. Rows should include `authors`, `series`, and the reader's `percent`. |
| GET | `/api/authors?q=&limit=` | ws/library | **new** | `{ items: {id,name}[] }`, only authors with at least one book the reader can see. |
| GET | `/api/books/:id` | lead | exists, needs fields | Add `authors`, `series`, `files: {id, format, sizeBytes}[]`, `percent`. |
| GET | `/api/books/:id/cover` | ws/library | **new** | Image bytes. Same lock check. |
| GET | `/api/books/:id/files/:fileId` | ws/library | **new** | The book file (EPUB/AZW3/MOBI/FB2/CBZ/PDF). Same lock check. Supports `Range`. Sets `Content-Type`. Never serves DRM'd Kindle files (rule 5). |
| GET | `/api/progress/:bookId` | ws/sync | **new** | `ProgressRecord` or 404 when never opened. `updatedAt` is the client time that wrote it. |
| PUT | `/api/progress/:bookId` | ws/sync | **new** | Body is `ProgressUpdate` from shared. Server keeps it only if `isNewerProgress`. Called with `fetch(..., { keepalive: true })` on tab hide, so keep it small and fast. |
| GET | `/api/bookmarks?bookId=` | ws/sync | **new** | `{ items: Bookmark[] }`, excluding soft-deleted. |
| POST | `/api/bookmarks` | ws/sync | **new** | `NewBookmark` → `Bookmark`. Check the reader can see `bookId`. |
| DELETE | `/api/bookmarks/:id` | ws/sync | **new** | Soft delete (`deleted_at`), own bookmarks only. |

## Locators

Reflowable books (EPUB, AZW3, MOBI, FB2) and CBZ save `{ kind: "epub", cfi, percent }`.
PDF currently opens in the browser's own viewer and doesn't report a position yet.

## Demo mode

`pnpm --filter @bookbandit/web demo` (or `?demo`, `?demo=kid` in the URL) swaps the HTTP
client for `src/api/demo.ts`, which follows the same contract with sample data.
