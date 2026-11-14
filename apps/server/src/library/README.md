# Library ingest and metadata

Scans `BOOKS_DIR`, reads metadata, looks books up online, rates them, and puts new books
in the admin inbox. Files stay plain files; the database can be rebuilt by rescanning
(admin ratings, approvals and series edits are the exceptions).

## Folder conventions

- Any layout works: Calibre (`Author/Title (id)/file.epub`), `Author/Title.epub`,
  `Author - Title (Series #2).epub`, or a flat folder.
- **Rating folders** (any depth, case-insensitive) set a rating: `explicit`/`erotica` →
  explicit, `adult`/`adults`/`mature` → adult, `teen`/`ya`/`young adult` → teen,
  `middle grade` → middle grade, `kids`/`children`/`picture-books` → kids.
- Hidden folders are skipped. Rejected inbox books go to `.rejected/` so rescans ignore them.

## Ratings (fail closed)

Every signal proposes a rating and the most restrictive wins; no signal = unrated = adult.

| Signal | Source | Example |
| --- | --- | --- |
| Rating folder | `folder` | `/books/adult/…` → adult |
| Google Books `maturityRating: MATURE` | `metadata` | → at least adult |
| ComicInfo `AgeRating` | `metadata` | `Adults Only 18+` → explicit, `Everyone 10+` → middle grade |
| Genres / subjects / content warnings | `keywords` | Erotica → explicit, Young Adult → teen, Juvenile → middle grade, Picture books → kids |

Admin ratings are never replaced. After approval, automatic ratings can only make a book
*more* restrictive, so a later lookup can never unlock a book for a kid.

## Online lookup

Hardcover (when `HARDCOVER_API_TOKEN` is set), Google Books (`GOOGLE_BOOKS_API_KEY` optional)
and Open Library. ISBN first, then title + author with a plausibility check. Turn off with
`METADATA_ONLINE=false`. Lookups fill empty fields only; titles and authors from the file win.

## Admin API (all `requireAdmin`)

| Method | Path | What |
| --- | --- | --- |
| `POST` | `/api/admin/library/scan` | Start a scan (202; one at a time) |
| `GET` | `/api/admin/library/scan` | Status, progress, last report |
| `GET` | `/api/admin/inbox?limit&offset` | Books waiting for approval, with files, rating and possible duplicates |
| `POST` | `/api/admin/inbox/approve` | `{ ids, rating? }` bulk approve |
| `POST` | `/api/admin/inbox/:id/approve` | `{ rating? }` |
| `POST` | `/api/admin/inbox/:id/reject` | `{ deleteFiles?: false }` moves files to `.rejected/` |
| `PUT` | `/api/admin/books/:id/rating` | `{ rating \| null }` admin rating |
| `POST` | `/api/admin/books/:id/metadata/refresh` | Online lookup now |
| `GET` | `/api/admin/library/duplicates` | Same bytes at several paths; separate books with the same ISBN or title |

Covers are saved to `CONFIG_DIR/covers/<bookId>.<ext>`; `books.cover_path` is relative to `CONFIG_DIR`.
