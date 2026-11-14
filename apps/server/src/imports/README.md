# Imports: moving in from Calibre, Calibre-Web, Kavita and others

Admin page: **Admin → Move in** (`/admin/import`). Every import runs on the job runner (job type
`import`, one attempt) and starts as a dry run. A dry run does the whole import inside a SQLite
transaction and rolls it back, so its report (matched, new, skipped, conflicts) is exactly what
the real run will do. Nothing outside the database (covers) is touched until a real run commits.

| Source | Reads | Writes |
| --- | --- | --- |
| Calibre | `metadata.db` (server folder or upload), `cover.jpg` next to the books | title, authors, series and index, tags (genre), publisher, language, description, year, ISBN, Google id, `book_identifiers`, cover; optionally approves matched inbox books (their age group is never changed) |
| Calibre-Web | `app.db` (+ Calibre `metadata.db`, or links from an earlier Calibre import) | per person: progress (finished / reading, Kobo %), `reading_history`, shelves → collections (public shelves → household collections) |
| Kavita | its API: `POST /api/Plugin/authenticate`, `POST /api/Series/all-v2`, `GET /api/Series/volumes`, `GET /api/Collection`, `GET /api/Series/series-by-collection` | per API key / person: progress (page locator for PDF/CBZ), finished history, collections |
| Goodreads / StoryGraph | their CSV exports (detected from the header) | one person's `reading_history` (also books the family doesn't own), finished progress, "Want to read" and shelf collections for books we have |
| Google Play Books | CSV (Title + Author/ISBN/Volume ID/Play link) or Google Books API JSON | metadata-only books (approved, unrated unless an age group is chosen) with a `google-play` identifier; the book page shows "Open in Google Play Books". No downloads, no DRM |

Matching scanned files: outside paths (`/calibre/Author/Title (42)/name.epub`) are matched to
`book_files.rel_path` by the longest common tail of path segments plus size; a bare file name only
counts when it's unique. Calibre then tries the file's SHA-256 (when its folder is readable), then
ISBN or title and author. Calibre books with no file in Bookbandit are skipped: scan first.

Progress from any import follows the usual rule: newest wins. When Bookbandit's position is newer,
the import keeps it and reports a conflict.

## Endpoints

- `POST /api/admin/imports/uploads?name=` — raw `application/octet-stream` body → `{ uploadId }`.
  Uploads live in `CONFIG_DIR/imports/uploads` and are swept after 7 days.
- `GET /api/admin/imports/people` — household people to map outside accounts to.
- `POST /api/admin/imports` — `{ source, dryRun, ... }` (zod schema `ImportRequest` in `index.ts`) → `202 { jobId }`.
  Server paths must end in `metadata.db` / `app.db` (or be the folder holding it). Kavita API keys are
  sealed with the SecretBox before they're stored in the job.
- `GET /api/admin/imports`, `GET /api/admin/imports/:id` — import jobs; the full report is on `:id`.
- `GET /api/reading-history/export.csv[?userId=]` — Goodreads-format CSV of your history plus books
  finished in Bookbandit (admins may export anyone in the household). Content lock: rows linked to
  books the viewer can't see are left out; kids only get rows for books they can see.
- `GET /api/books/:id/elsewhere` — `{ googlePlay: { url } | null }`, behind `assertCanSee` (404 when locked).

## Tables (`schema.ts`, migration `0011_migrate`)

`reading_history` (unique per person + source + source key, so re-imports update), `book_identifiers`,
`import_links` (outside id → book). Not rebuilt by a rescan, like progress.

Not done yet: Calibre-Web's `kobo_synced_books` (which books a Kobo syncs) and Kavita's want-to-read
list; Calibre's own star ratings and custom columns.
