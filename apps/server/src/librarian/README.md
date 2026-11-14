# Librarian tools (ws/librarian)

What Calibre's desktop app still did for the family: duplicates, bulk edit, format conversion,
covers and library health. Web pages: **Admin → Librarian** (`apps/web/src/librarian/`).

Everything is admin-only (`requireAdmin`). These are moderation tools, so like the inbox they list
books whatever their rating or approval; reader-facing lists stay behind `visibleBooksWhere`.

## Files never get deleted

- Duplicates you don't keep move to `BOOKS_DIR/.duplicates/<original path>`. Scans skip hidden
  folders, so they stay out of the library; move a file back to undo.
- Converted EPUBs go next to the original (`Author/Book.mobi` → `Author/Book.epub`, or
  `Book (converted).epub` if that name is taken) and are attached to the same book at once, so a
  rescan sees a known file. The original is untouched.
- KEPUB copies for Kobo live in `CONFIG_DIR/cache/kepub` (the same cache the Kobo download route uses).
- DRM-protected files are never converted or rewritten (CLAUDE.md rule 5).

## Jobs (on the job runner)

| Type | What |
| --- | --- |
| `librarian.convert` | `{ bookId, fileId, to: "epub" }`: `ebook-convert` (`EBOOK_CONVERT_PATH`) MOBI/AZW3/FB2/TXT → EPUB |
| `librarian.kepub` | `{ bookIds? }`: kepubify every EPUB (or those books) into the Kobo cache ahead of time |
| `librarian.writeMetadata` | `{ bookId }`: write title, authors, language, description, publisher, ISBN and Calibre series tags into the book's EPUBs, then update the file's hash so a rescan sees it unchanged |
| `librarian.health` | Open every file: missing on disk, unreadable (empty, bad zip, no OPF, bad PDF/MOBI header), DRM. The report is kept in `settings` (`librarian.health`) |

"Write details into the file" is **off by default** (`PUT /api/admin/librarian/settings`
`{ writeMetadata: true }`). When on, a bulk edit of series, authors or language queues it.

## API

| Method | Path | What |
| --- | --- | --- |
| `GET` | `/api/admin/librarian/books?q&check&format&seriesId&sort&limit&offset` | Books with authors, series, tags, files. `check` is `no_cover`, `no_rating`, `no_author` or `no_files` |
| `GET` | `/api/admin/librarian/series` | Series names with book counts (for the bulk-edit picker) |
| `POST` | `/api/admin/librarian/bulk` | `{ ids, series?: { name, numbering: keep\|sequence\|clear, start } \| null, tagsAdd?, tagsRemove?, rating?, authors?, language? }`. Series set here become admin-managed |
| `GET` | `/api/admin/librarian/duplicates` | `{ sameWork: [{ key, reason: isbn\|title_author\|title, books }], copies: [{ sha256, files }], ignored }` |
| `POST` | `/api/admin/librarian/duplicates/merge` | `{ keepId, otherIds }`: every format, progress, bookmark and shelf onto one book |
| `POST` | `/api/admin/librarian/duplicates/keep` | `{ keepId, otherIds }`: others' files to `.duplicates`, their reading data to the kept book |
| `POST` | `/api/admin/librarian/duplicates/copies` | `{ fileIds }`: set aside extra copies of identical files (the last copy always stays) |
| `POST` / `DELETE` | `/api/admin/librarian/duplicates/ignore` | `{ bookIds }` marks a group "not duplicates" (shows again if the group changes); `DELETE` clears all |
| `GET` | `/api/admin/librarian/tools` | Whether ebook-convert and kepubify run here, counts, settings, recent librarian jobs |
| `GET` | `/api/admin/librarian/convertible` | Books with MOBI/AZW3/FB2/TXT and no EPUB |
| `POST` | `/api/admin/librarian/convert` | `{ bookIds, force? }` → 202 `{ queued, skipped }`; 409 when ebook-convert is missing |
| `POST` | `/api/admin/librarian/kepub` | `{ bookIds? }` → 202 `{ jobId }` |
| `GET` / `PUT` | `/api/admin/librarian/settings` | `{ writeMetadata }` |
| `POST` | `/api/admin/librarian/write-metadata` | `{ bookIds }`; 409 while the setting is off |
| `GET` | `/api/admin/librarian/books/:id/covers` | Candidates: covers inside the book's EPUB/CBZ files and online lookup results |
| `GET` | `/api/admin/librarian/books/:id/covers/file/:fileId` | The cover image inside one file |
| `GET` | `/api/admin/librarian/books/:id/cover` | Current cover for admins (works for inbox and locked books) |
| `POST` | `/api/admin/librarian/books/:id/cover` | `{ url }`, `{ fileId }` or `{ image: base64/data URL }` (JPEG, PNG, WebP or GIF, up to 10 MB). The web cropper uploads a 600×900 JPEG |
| `GET` | `/api/admin/librarian/health` | Counts per check, last file report, running check |
| `POST` | `/api/admin/librarian/health/check` | Start (or return the running) file check |

Tables: `duplicate_ignores` (`schema.ts`, migration `0008_librarian`).
