# Web app ⇄ server API contract

What `apps/web` calls (`src/api/client.ts`), and who provides it. Every endpoint that returns
books uses `visibleBooksWhere` / `assertCanSee` (CLAUDE.md rule 1); locked books are 404.
Web-side types: `apps/web/src/api/types.ts`. Shared types: `@bookbandit/shared`.

| Method | Path | Provided by | Notes |
| --- | --- | --- | --- |
| GET | `/api/users/me` | ws/auth, merged | `id, displayName, role, avatar, theme, birthYear, explicitOptIn`. The web app derives `isKid` from `role` and `maxRating` with `maxAllowedRating()` (`toMe` in client.ts). |
| PATCH | `/api/users/me` | ws/auth, merged | `{ theme }`. Theme ids: `THEME_IDS` / `isThemeId` in shared. |
| GET | `/api/shelves` | lead, merged ([catalog-api.md](../../docs/catalog-api.md)) | `{ items: Shelf[] }`, each with `total`. Shelf ids `continue`, `recent`, `kid`, `series:<id>`, `collection:<id>`, `tag:<id>`; each id also works as `?shelf=` on `/api/books`. |
| GET | `/api/books` | lead, merged | Query `q, author` (author **id**), `yearFrom, yearTo, ratings` (comma list, intersected with the reader's allowed ratings), `shelf, sort` (`title, author, year, added`), `limit, offset`. Returns `total`; rows include `authors`, `series`, `percent`. |
| GET | `/api/books/:id` | lead, merged | Adds `authors`, `series`, `files: {id, format, sizeBytes}[]`, `percent`. |
| GET | `/api/authors?q=&limit=` | lead, merged | `{ items: {id, name}[] }`, only authors with a book the reader can see. |
| GET | `/api/books/:id/cover` | ws/library | Image bytes, same lock check. |
| GET | `/api/books/:id/files/:fileId` | ws/library | The book file, same lock check, `Range` support, never DRM'd Kindle files (rule 5). |
| GET | `/api/progress/:bookId` | ws/sync, merged | `{ progress: ProgressRecord \| null }`. See [docs/sync-api.md](../../docs/sync-api.md). |
| PUT | `/api/progress/:bookId` | ws/sync, merged | `{ locator, updatedAt, deviceName, percent?, finished? }` → `{ status: "applied" \| "stale", progress }`. Sent with `keepalive` on tab hide. |
| POST | `/api/progress/batch` | ws/sync, merged | Offline queue upload on start-up and when the network returns. |
| GET | `/api/books/:bookId/bookmarks` | ws/sync, merged | `{ items: BookmarkRecord[] }` |
| POST | `/api/bookmarks` | ws/sync, merged | The web app sends its own UUID `id`, so a retry can't duplicate. |
| DELETE | `/api/bookmarks/:id` | ws/sync, merged | Soft delete. |
| GET | `/api/books/:id/audio`, `/audio/tracks/:index` | ws/integrations, merged | Audiobook tracks, chapters, the reader's position, `source` (`local`/`audiobookshelf`) and `prefs`; `src/audio/`. Local audiobooks and ABS share it (ws/audio). |
| PUT | `/api/books/:id/audio/prefs` | ws/audio | `{ speed?, skipSilence? }`, remembered per book. |
| GET/POST | `/api/books/:id/audio/bookmarks` | ws/audio | Listening bookmarks `{ time, note? }`; `?since=` includes deletes. PATCH/DELETE `/api/audio/bookmarks/:id`. |
| PUT | `/api/books/:id/audio/progress` | ws/integrations, merged | `{ currentTime, duration, finished?, deviceName, clientUpdatedAt }`, newest wins. |
| GET, PUT, DELETE | `/api/kindle/me`, `/api/kindle/addresses/:userId` | ws/integrations, merged | Send to Kindle address; `src/kindle/`. |
| POST | `/api/books/:id/send-to-kindle` | ws/integrations, merged | EPUB preferred, then PDF. |
| GET | `/api/storyteller/kids/:kidId` (`me` ok) | ws/listen | Storyteller shelf, settings, tonight's allowance; `src/storyteller/`. |
| PUT | `/api/storyteller/kids/:kidId/settings` | ws/listen | Parent/admin only. |
| GET | `/api/storyteller/kids/:kidId/history` | ws/listen | What was played lately. |
| POST | `/api/storyteller/stories`, `/sessions/:id/beat`, `/sessions/:id/end` | ws/listen | Kid only. 409 `{ goodnight, tonight }` when tonight is used up. |
| PUT | `/api/shelves/kids/:kidId/books/:bookId` | ws/sync, merged | `{ storyteller: true }` puts a book in story time. |

## Locators

Reflowable books (EPUB, AZW3, MOBI, FB2) and CBZ save `{ kind: "epub", cfi, percent }`.
PDF opens in the browser's own viewer for now and doesn't report a position yet.
| GET | `/api/auth/status` | ws/auth | `setupRequired, signedIn, device, google: {url} \| null, unlinkedEmail, limits`. Drives the sign-in screens. |
| POST | `/api/auth/setup` | ws/auth | First run only: `{ householdName, displayName, username, password, email? }`. |
| POST | `/api/auth/login` | ws/auth | `{ username, password }` or `{ userId, password }` from the picker. Sets the `bb_session` cookie. |
| GET | `/api/auth/profiles` | ws/auth | "Who's reading?" tiles; only on a paired tablet or when signed in. |
| POST | `/api/auth/kid-sign-in` | ws/auth | `{ userId, pin }` or `{ userId, pictures }` (ids from `SIGN_IN_PICTURES`). |
| POST | `/api/auth/sign-out` | ws/auth | Clears the session cookie; a paired tablet stays paired. |
| POST | `/api/devices/claim` | ws/auth | `{ code, name? }`. Sets the `bb_device` cookie in a tablet's browser. |
| GET / PATCH | `/api/users`, `/api/users/:id` | ws/auth | Settings → kids' names (`{ displayName }`, linked parent or admin). |

## Demo mode

`pnpm --filter @bookbandit/web demo` (or `?demo`, `?demo=kid` in the URL) swaps the HTTP
client for `src/api/demo.ts`, which follows the same shapes with sample data.
