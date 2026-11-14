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
    { "id": "openlibrary-weekly", "name": "Trending this week", "source": "openlibrary", "items": [DiscoverItem], "error": "optional" }
  ],
  "online": true,
  "requests": true
}
```

Lists, in order: `hardcover-trending` (only with `HARDCOVER_API_TOKEN`), `openlibrary-weekly`,
`openlibrary-yearly`, then `family` ("Popular in your family": books the most household members
have started, from `reading_progress`). Outside lists are cached in memory for 6 hours (10 minutes
after a failure, keeping the last good copy) and skipped entirely when `METADATA_ONLINE=false`.
Only generic requests leave the server; nothing about the household is sent.

A `DiscoverItem`:

| Field | Meaning |
| --- | --- |
| `status` | `library` (readable here), `kindle` (a Kindle-only entry), or `request` |
| `bookId`, `coverPath` | Set when matched to a book this reader can see |
| `onKindle` | The household owns it on Kindle (a Kindle-only entry, or a file book with an ASIN) |
| `coverUrl` | Outside cover, when there's no local one |
| `title`, `authors`, `year`, `isbn13`, `url`, `source`, `key` | From the list |

Matching uses ISBN-13, the Open Library work id or the Hardcover id, then title plus an
overlapping author. Only books visible to the reader can match, so a locked book shows as
`request` rather than hinting that it's on the shelf.

**Kids and other readers who can't see adult books**: outside books are unrated, and unrated means
adult, so they only get outside items that matched a book they can already see. `requests` is
`false` for them and the web app hides the Request button.

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

Categories are the existing `tags` table: `genre` (from metadata), `section` (Kids, Cookbooks …;
these also get a home shelf) and `custom`.

| Method | Path | Who | Notes |
| --- | --- | --- | --- |
| GET | `/api/categories?q=&kind=&covers=3` | reader | `{ items: [{ id, name, kind, bookCount, cookbook, books }] }`, sections first, then by size. Categories with no visible books are left out. |
| GET | `/api/categories/:id?limit=&offset=&sort=` | reader | `{ category, items, total }`; 404 when nothing in it is visible |
| GET | `/api/books/:id/categories` | reader | `{ items, cookbook }` for one visible book |
| POST | `/api/categories` | admin | `{ name, kind: "section" \| "custom" }` → 201 |
| PUT | `/api/categories/:id/books` | admin | `{ add: [bookId], remove: [bookId] }` |
| DELETE | `/api/categories/:id` | admin | 204 |

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
