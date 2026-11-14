# Reading sync API

Per-profile reading state that follows a reader across the web reader, tablets and later
Kobo/KOReader. Every route needs a signed-in reader and goes through the content lock:
a book the reader can't see returns 404, and list endpoints silently leave it out (so a book
re-rated above a kid's level disappears from their progress, bookmarks and shelves at once).

Times are integer ms since epoch unless noted. `percent` is a fraction from 0 to 1.
Types live in `@bookbandit/shared` (`ReadingLocator`, `ProgressRecord`, `BookmarkRecord`).

**Do a full sync now and then.** The `since` cursors only return rows that changed. If a book is
re-rated or approved so a reader can see it again, its old progress and bookmarks didn't change, so
they won't come back through `since`. Clients should do a full sync (no `since`) on app start or
once a day, and use `since` in between.

## Progress

| Route | What it does |
| --- | --- |
| `PUT /api/progress/:bookId` | Save a position: `{ locator, updatedAt, deviceName, percent?, finished? }`. `updatedAt` is the device clock (ISO 8601 or ms). Replies `{ status: "applied" \| "stale", progress }`; on `stale` the reply carries the newer position the client should jump to. |
| `POST /api/progress/batch` | Upload up to 500 offline updates `{ updates: [{ bookId, ...same body }] }`. Each gets `applied`, `stale` or `not_found`. |
| `GET /api/progress/:bookId` | `{ progress }` or `{ progress: null }`. |
| `GET /api/progress?since=` | Positions changed after `since` (server ms). Keep `serverTime` from the reply and send it next time. Omit `since` for everything. |
| `DELETE /api/progress/:bookId` | Forget a position ("start over" / remove from Continue reading). |

Newest wins by the device clock, so an offline tablet uploading later can't overwrite a newer
position. Device times in the future are clamped to the server clock. `percent` defaults to what
the locator implies and `finished` defaults to `percent >= 0.99`.

## Bookmarks, highlights, stickers

| Route | What it does |
| --- | --- |
| `POST /api/bookmarks` | `{ id?, bookId, kind: "bookmark" \| "highlight" \| "sticker", locator, text?, note?, color? }`. Send your own UUID `id` for offline-made items; re-posting it is a no-op. |
| `PATCH /api/bookmarks/:id` | Change `locator`, `text`, `note` or `color`. |
| `DELETE /api/bookmarks/:id` | Soft delete; other devices see `deletedAt` on their next sync. |
| `GET /api/books/:bookId/bookmarks` | Live items for one book. |
| `GET /api/bookmarks?since=` | Everything changed after `since`, including deletions (by `updatedAt`). Without `since`, all live items. Returns `serverTime` for next time. |

For stickers, `text` holds the sticker's name. `color` is a hex like `#ffcc00` or a color name.

## Shelves

| Route | What it does |
| --- | --- |
| `GET /api/shelves/continue?limit=` | Started, unfinished books, most recently read first, with progress. |
| `GET /api/shelves/finished?limit=` | Finished books. |
| `GET /api/shelves/kids/:kidId?storyteller=` | A kid's hand-picked shelf with their progress. `kidId` may be `me`. Visible to the kid, a linked parent, or an admin; anyone else gets 404. |
| `PUT /api/shelves/kids/:kidId/books/:bookId` | Parent/admin adds a book (`{ storyteller? }`). Kids get 403. A book above the kid's level, or still waiting in the inbox, gets 422 with a reason. |
| `DELETE /api/shelves/kids/:kidId/books/:bookId` | Parent/admin removes it. |

Kid shelves are filtered as the kid and as the viewer, so a later re-rating hides a book there too.
