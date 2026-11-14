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

## Reading time

Active reading and listening time, for the parent dashboard and streaks. Clients count only time
when the book is on screen and the reader did something in the last few minutes, then send it in
heartbeats about once a minute (the web reader does this in `apps/web/src/reader/readingTimer.ts`).

| Route | What it does |
| --- | --- |
| `POST /api/reading/heartbeat` | `{ sessionId (client UUID), bookId, seconds 1–300, kind: "read" \| "listen", deviceName? }`. Adds time to the session, creating it on the first beat (201, later 200). The server counts at most the wall-clock time since the session's last beat plus 5 s, so a client can't inflate it; the response's `counted` says how much was kept. A book the reader can't see is 404; a session id that belongs to another reader or book is 409. |
| `GET /api/reading/stats?userId=&days=&utcOffset=` | Totals for the last `days` (1–90, default 7). `userId` defaults to the caller; a linked parent or a same-household admin may ask about a kid. Returns `{ user, totalSeconds, streakDays, days: [{ date, readSeconds, listenSeconds }], books: [{ id, title, coverPath, seconds }] }`. `utcOffset` is the viewer's offset in minutes (as `-new Date().getTimezoneOffset()`) so days split at local midnight. |

Books in `books` are filtered as both the subject and the viewer, so a book re-rated above a kid's
level drops out of the list while its minutes still count in the totals. Anyone else asking about
a user gets 404; a kid asking about someone else gets 403. Sessions live in `reading_sessions`
(migration 0003).
