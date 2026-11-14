# Discover, series, categories and Kindle import API

Workstream 11 (`ws/discover`). Server code: `apps/server/src/discover/`. Web: `apps/web/src/discover/`
and `apps/web/src/series/`. Tests: `apps/server/test/discover.test.ts`.

Every endpoint that returns books filters with `visibleBooksWhere(reader)` or checks
`assertCanSee` (CLAUDE.md rule 1). Locked or missing things are 404. Admin endpoints use
`requireAdmin` and answer 403 to everyone else.

## Discover

`GET /api/discover?limit=20` returns

```json
{
  "lists": [
    { "id": "openlibrary-weekly", "name": "Trending this week", "source": "openlibrary", "group": "popular", "items": [DiscoverItem], "error": "optional" }
  ],
  "online": true,
  "requests": true
}
```

Rows come in groups (`group`), in this order, and a book only shows in the first row that has it
(matched library id, ISBN, or title plus first author). Books the reader has already opened are left
out of every row except `family`.

| Group | Rows (`id`) | Where from |
| --- | --- | --- |
| `foryou` | `series-next` "Next in your series" | The next library books in series the reader is part-way through, then (with a Hardcover token) the next books the library is missing, with a note like "Book 3 of Mistborn" |
| | `because-<bookId>` "Because you read X" (up to 2, `aboutBookId` set) | Barnaby's "more like this" (shared author, series or genre, plus meaning search when embeddings are set up), then Open Library books on the same subjects by other authors |
| | `author-<name>` "More by X" (up to 2) | Unread library books by the reader's most-read authors, then their popular Open Library books |
| `popular` | `hardcover-trending` (token only), `openlibrary-weekly`, `openlibrary-new` "New and noteworthy" | Trending lists; "new" is books first published this year or last, sorted by Open Library trending |
| `genres` | `genre-<category>` (up to 8) | Open Library searches for the curated categories, the reader's favourite genres first. Readers who can't see outside books get rows from their own visible library instead |
| `awards` | `awards`, `awards-kids` | Hand-picked prize winners in `awards.ts` (Booker, Pulitzer, Hugo, Women's Prize; Caldecott, Newbery, Printz), with English covers looked up weekly |
| `family` | `family` "Popular in your family" | Books the most household members have started |

Open Library searches ask for English editions (`language:eng`, `lang=en`) and take the English
edition's cover; trending works are looked up once more for the same reason, and works with no
English edition are dropped. Outside lists are cached in memory for 6 hours (a week for prize
lists, 10 minutes after a failure, keeping the last good copy), at most 4 requests at once, and a
page view waits at most 8 seconds for them (slower lists fill the cache for next time). They're
skipped entirely when online lookups are off (admin settings or `METADATA_ONLINE=false`).
Only generic requests leave the server; nothing about the household is sent.

A `DiscoverItem`:

| Field | Meaning |
| --- | --- |
| `status` | `library` (readable here), `kindle` (a Kindle-only entry), or `request` |
| `bookId`, `coverPath` | Set when matched to a book this reader can see |
| `onKindle` | The household owns it on Kindle (a Kindle-only entry, or a file book with an ASIN) |
| `coverUrl` | Outside cover, when there's no local one |
| `title`, `authors`, `year`, `isbn13`, `url`, `source`, `key` | From the list |
| `note` | Optional reason line: "Book 3 of Pebble Bay", "Also by Ann Leckie", "Caldecott Medal 2024" |
| `requestable` | Not in the library and this reader may ask for it (shows Request it) |

Matching uses ISBN-13, the Open Library work id or the Hardcover id, then title plus an
overlapping author. Only books visible to the reader can match, so a locked book shows as
`request` rather than hinting that it's on the shelf.

**Kids and other readers who can't see adult books**: outside books are unrated, and unrated means
adult, so they only get outside items that matched a book they can already see. `requests` is
`false` for them. The one exception is the kids' prize list: each prize carries the audience it is
for (Caldecott `kids`, Newbery `middle_grade`, Printz `teen`), so a kid sees, and can request, the
winners at or under their own limit. The server still guesses the request's rating itself.

The web app's "Request it" button calls `POST /api/requests` with `{ title, author, isbn13 }`
(owned by `ws/requests`). Until that exists it says requests aren't switched on yet.

## Series

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/api/series?q=&limit=&offset=&covers=4` | reader | Series with at least one visible book: `{ items: [{ id, name, description, adminManaged, bookCount, books }], total }`. `bookCount` counts visible books only. |
| GET | `/api/series/:id` | reader | `{ id, name, description, adminManaged, books }`, books in reading order: position (1, 1.5, 2 …), then unnumbered by year and title. 404 if every book is locked (admins see empty series). |
| POST | `/api/series` | admin | `{ name, description?, books?: [{ bookId, position? }] }` → 201 |
| PATCH | `/api/series/:id` | admin | `{ name?, description? }` |
| PUT | `/api/series/:id/books` | admin | `{ books: [{ bookId, position? }] }` replaces the list in order; position defaults to 1, 2, 3 … Unknown ids → 400. |
| DELETE | `/api/series/:id` | admin | 204; the books stay |

Any admin edit sets `adminManaged`, and the scanner's `setBookSeries` leaves books in an
admin-managed series alone, so a rescan or metadata refresh keeps the admin's version.

## Categories

Categories are the existing `tags` table: `genre` (a curated category), `subject` (a raw metadata
subject, never listed), `section` (Kids, Cookbooks …; these also get a home shelf) and `custom`.

**Where categories come from.** Every metadata source (EPUB `dc:subject`, Open Library, Google
Books, Hardcover genres and tags, ISBNdb, Calibre tags, CBZ `Genre`/`Tags`) sends free-form subjects.
They are kept as `subject` tags (up to 12 a book, noise dropped, near-duplicates such as
"Dragon"/"dragons" folded together) so search, "More like this" and Barnaby still use them. Each
book is then filed under at most three curated categories plus one audience (Children's Books or
Young Adult) by the rules in `apps/server/src/discover/taxonomy.ts`; a book with subjects but no
match gets "Fiction" or "Nonfiction". Admin merges and renames are stored in `category_aliases` and
hides in `category_prefs`, so a rescan respects them. Genre categories with fewer visible books
than the admin's minimum (setting `categories.minBooks`, default 3) don't get a tile.

On first start after upgrading, every old `genre` tag (one per raw subject) becomes a `subject`,
duplicates are merged and every book is filed under the curated list. Book links are moved, never
dropped; it runs once (setting `categories.taxonomy`).

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/api/categories?q=&kind=&covers=3` | reader | `{ items: [{ id, name, kind, bookCount, cookbook, books }] }`, sections first, then by size. Categories with no visible books, hidden ones, raw subjects and genres under the minimum are left out. |
| GET | `/api/categories/:id?limit=&offset=&sort=` | reader | `{ category, items, total }`; 404 when nothing in it is visible |
| GET | `/api/books/:id/categories` | reader | `{ items, cookbook }` for one visible book |
| POST | `/api/categories` | admin | `{ name, kind: "section" \| "custom" }` → 201 |
| PUT | `/api/categories/:id/books` | admin | `{ add: [bookId], remove: [bookId] }` |
| DELETE | `/api/categories/:id` | admin | 204 |
| PATCH | `/api/categories/:id` | admin | `{ name?, hidden?, kind?: "genre" \| "subject" }`; renaming onto an existing name merges → `{ id, name, kind, merged }` |
| POST | `/api/categories/:id/merge` | admin | `{ into }`: moves every book, deletes this tag, its name now lands on `into` → `{ id, bookCount }` |
| GET | `/api/admin/categories?kind=all\|categories\|genre\|subject\|section\|custom&q=` | admin | `{ items: [{ id, name, kind, bookCount, hidden, curated, shown, aliases }], counts, minBooks }` |
| PUT | `/api/admin/categories/settings` | admin | `{ minBooks }` |
| POST | `/api/admin/categories/rebuild` | admin | Re-files every book from its subjects (adds only) → `{ books, linked }` |

`cookbook` is `isCookbookCategory(name)` from `@bookbandit/shared` (cookbook, cooking, recipes,
baking, kitchen …). The book page shows **Cook mode** (`/cook/:id`) for those books: the screen
stays on (Screen Wake Lock API, re-taken when the tab comes back), large scrolling text, a
searchable recipe index from the table of contents, and reading position syncs as usual.

## Kindle library import

`POST /api/admin/kindle/import` (admin) with `{ csv, rating?, dryRun? }` returns
`{ rows, created, linked, skipped, errors, dryRun }`.

- Columns are matched by name in any order: `ASIN`/`Product ID`, `Title`/`Product Name`,
  `Author`/`Authors`/`Author(s)`, optional `ISBN`. Commas, semicolons or tabs; quotes and a BOM are
  fine. Amazon's " Kindle Edition" / "eBook" decorations are trimmed and "Last, First" names flipped.
- New rows become `kindle_only` books with `kindle_asin`, approved (an admin imported them) and
  unrated unless `rating` is given. Unrated means grown-ups only until someone rates them.
- A row that matches a book you already have (same ISBN, or title plus author) adds the ASIN to it
  (`linked`) instead of making a duplicate. A repeated ASIN is `skipped`.
- Nothing is downloaded and no DRM is touched. The book page's **Read in Kindle** button opens
  `https://read.amazon.com/?asin=…` (`kindleReadUrl` in shared).
- The scanner never removes `kindle_only` books, since they have no files.

No migration: everything uses existing columns and tables.
