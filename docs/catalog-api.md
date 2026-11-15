# Catalog API

Browsing the library. Every route needs a signed-in reader and goes through the content lock:
locked books never appear in lists or counts, and opening one directly returns 404.

## Books

`GET /api/books`

| Param | Meaning |
| --- | --- |
| `q` | Matches title or author name (case-insensitive, `%` and `_` are literal) |
| `author` | Author id |
| `yearFrom`, `yearTo` | Published year range, inclusive |
| `ratings` | Comma list, e.g. `kids,middle_grade`. Only narrows: it can never show more than the reader's limit |
| `shelf` | `continue`, `recent`, `kid`, `series:<id>`, `collection:<id>`, `tag:<id>` (unknown → 400) |
| `sort` | `title` (default), `author`, `year`, `added` (default for `shelf=recent`) |
| `limit`, `offset` | Paging, limit up to 200 |

Reply: `{ items, limit, offset, total }`. Each item: `id, title, publishedYear, rating, coverPath,
kindleOnly, authors: [{id, name}], series: [{id, name, position}], percent` (the reader's progress
0 to 1, or null).

`GET /api/books/:id` returns the book's fields plus `authors`, `series`, `percent` and
`files: [{ id, format, sizeBytes }]`. File paths on disk are never returned. Cover and file bytes
are served by the library workstream (`/api/books/:id/cover`, `/api/books/:id/files/:fileId`).

## Authors

`GET /api/authors?q=&limit=` → `{ items: [{ id, name }] }`, only authors with at least one book
the reader can see, sorted by sort name.

## Home shelves

`GET /api/shelves?perShelf=20&maxSeries=5` → `{ items: Shelf[] }` where a shelf is
`{ id, name, kind, total, books }`. Order: Continue reading, Parent approved (kids only: picked for them or their whole family), Recently added,
section tags (Kids, Cookbooks, ...), household collections (shared ones plus the reader's own),
then the series with the most recently added books. Empty shelves are left out. Each shelf's `id`
works as `?shelf=` on `/api/books` to page through the rest.
