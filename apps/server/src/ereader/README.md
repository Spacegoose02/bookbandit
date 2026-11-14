# E-reader sync: OPDS, KOReader, Kobo

Owned by `ws/ereader`. Code: `src/ereader/` (sign-ins, shared book access, position
translation, schema), `src/opds/`, `src/koreader/`, `src/kobo/`. Tests: `test/ereader.test.ts`.

## Sign-ins

E-readers can't do Tinyauth or QR pairing, so each gets its own sign-in, made in the web app
under **E-readers** (`/settings/ereaders`) or with the API:

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/ereader/credentials` | your own, plus everyone you manage; also returns the OPDS and kosync URLs |
| POST | `/api/ereader/credentials` `{ kind: "login" \| "kobo", name, userId?, username? }` | adults for themselves; parents for linked kids; admins for anyone. Never kids. |
| DELETE | `/api/ereader/credentials/:id` | same as create |

- `login`: a username and a generated password (`k7qm-4xpa-9hzt-wr3d`), for OPDS (HTTP Basic) and
  KOReader sync. Stored as `sha256(md5(password))`, because KOReader only ever sends `md5(password)`.
- `kobo`: a token (`bbk_…`) that goes in the Kobo's `api_endpoint` URL. Stored as `sha256(token)`.

The password and token are in the create reply only. Every request made with a sign-in acts as
its person through the content lock. Failed attempts are rate-limited per client IP.

## Reverse proxy

`/opds`, `/kosync` and `/kobo` must **bypass Tinyauth** (forward auth) on the reverse proxy: the
e-reader authenticates to Bookbandit itself. The web app's own pages stay behind Tinyauth.

## OPDS 1.2 (`/opds`)

Navigation: Continue reading, My shelf (kids), Recently added, All books, Authors, Series,
Genres, and search (OpenSearch at `/opds/search.xml` plus a `{searchTerms}` link). Feeds page at 50.
Entries carry authors, language, year, publisher, ISBN, description, series, cover and one
acquisition link per file. Downloads (`/opds/books/:id/files/:fileId`) support Range and refuse
DRM files.

Content lock: every list, count and nav list starts from `visibleBooksWhere`; authors, series and
genres with no visible book are left out and their feeds return 404. Kindle-only books and books
with no file are left out. Basic auth wins over the browser's sign-in; without either, 401 with a
`WWW-Authenticate: Basic` challenge.

## KOReader sync (`/kosync`)

kosync-compatible: `GET /users/auth`, `PUT /syncs/progress`, `GET /syncs/progress/:document`.
Sign-ups (`POST /users/create`) answer 402: create the login in Bookbandit. In KOReader: Tools →
Progress sync → Custom sync server → `https://<server>/kosync`, then Login.

- Every update is stored as sent (`koreader_progress`), so files outside the library still sync
  between KOReader devices.
- Library files are found by KOReader's document id: the partial MD5 (default "binary" matching)
  or the MD5 of the file name. `ereader_file_digests` caches both and is refreshed on a miss.
- For a library book the person may see, the position is also written to `reading_progress`
  (newest wins). EPUB XPointers (`/body/DocFragment[N]/body/div/p[3]/text().0`) become CFIs for
  the same element (`epubcfi(/6/2N!/4/2/8)`) by walking the chapter's XHTML; PDF/CBZ pages map
  to page locators (KOReader counts from 1, the web reader from 0).
- When `reading_progress` is newer (the web reader or a tablet moved on), GET returns that
  position as an XPointer instead. Character offsets are dropped: you land on the paragraph.
- A locked book behaves exactly like an unknown file: its `reading_progress` is never read or
  written, and the reply is the same.

## Kobo sync (`/kobo/<token>`)

Set `api_endpoint=https://<server>/kobo/<token>` in `.kobo/Kobo/Kobo eReader.conf`
(`[OneStoreServices]`), then tap Sync.

- `/v1/initialization` returns the store's resource map with every store-API URL pointed back
  here and covers at `/covers/…`. Nothing is proxied to Kobo's servers; other store calls get `{}`.
- `/v1/library/sync` sends NewEntitlement/ChangedEntitlement for books with an EPUB or KEPUB the
  person may see, 100 per reply (`x-kobo-sync: continue`), tracked per sign-in in
  `kobo_synced_books`. The sync token (`x-kobo-synctoken`) carries the reading-state cursor; a
  missing or foreign token means a full resend. Books that become invisible (re-rated, unapproved,
  deleted, no file) are sent as `IsRemoved` with no metadata and dropped from the device.
- Downloads are KEPUB via kepubify (`KEPUBIFY_PATH`, cached in `CONFIG_DIR/cache/kepub`), or the
  EPUB when kepubify isn't available or fails. Admin → Librarian → Convert → "Prepare for Kobo" converts
  every EPUB ahead of time on the job runner, so a sync never waits on kepubify.
- Reading state: PUT writes `kobo_reading_states` (verbatim) and `reading_progress` (chapter from
  the bookmark's `Source`, plus the percentage). GET and sync return the Kobo's own bookmark while
  it's newest, else the web position as the chapter's first `KoboSpan`. Changed positions go out
  as ChangedReadingState on the next sync.
- "Remove from device" (`DELETE /v1/library/:id`) marks the book archived for that sign-in until
  it changes.

Not done yet: Kobo collections/shelves from Bookbandit collections, cover resizing, and testing
against a physical Kobo (the protocol follows calibre-web's implementation).
