/**
 * Library scan: makes the database match the files under BOOKS_DIR.
 *
 * - Unchanged files (same size + mtime) are skipped without hashing.
 * - New files are hashed (sha256). A hash that matches a file which disappeared is a move;
 *   a hash that matches a file still on disk is an exact duplicate (attached to the same book
 *   and reported). Otherwise metadata is read, matched to an existing work (same ISBN, or same
 *   title + author → another format of that book), or a new book is created in the inbox.
 * - Files that are gone lose their row; the book stays (with its progress) and is reported missing.
 *
 * New books are never visible to non-admins until approved (books.approved = false).
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bookFiles, books } from "../db/schema.js";
import { extractMetadata } from "../metadata/extract.js";
import { autoRating, NON_AUTHOR_DIRS, shouldReplaceRating } from "../metadata/rating.js";
import type { LookupOptions } from "../metadata/lookup.js";
import { sha256File } from "./hash.js";
import { walkBooks, type DiskFile } from "./walk.js";
import { saveCover } from "./covers.js";
import { addGenreTags, bookFieldsFrom, filePathsForBook, findSameWork, setBookAuthors, setBookSeries } from "./store.js";
import { enrichBook } from "./enrich.js";

export interface ScanOptions {
  db: Db;
  booksDir: string;
  configDir: string;
  /** Online lookup for new books; false = file metadata only. */
  online: LookupOptions | false;
  onProgress?: (done: number, total: number) => void;
}

export interface ScanReport {
  startedAt: number;
  finishedAt: number;
  filesSeen: number;
  unchanged: number;
  /** New books created (waiting in the inbox). */
  added: number;
  /** New files attached to an existing book (another format or an exact copy). */
  attached: number;
  /** Changed in place (size or mtime differ). */
  updated: number;
  moved: number;
  /** File rows removed because the file is gone. */
  removed: number;
  /** Exact copies: same bytes at two paths. */
  duplicates: { relPath: string; sameAs: string }[];
  /** Books that no longer have any file on disk (kept, so progress isn't lost). */
  missingBookIds: string[];
  errors: { relPath: string; error: string }[];
}

export async function scanLibrary(opts: ScanOptions): Promise<ScanReport> {
  const { db } = opts;
  const report: ScanReport = {
    startedAt: Date.now(),
    finishedAt: 0,
    filesSeen: 0,
    unchanged: 0,
    added: 0,
    attached: 0,
    updated: 0,
    moved: 0,
    removed: 0,
    duplicates: [],
    missingBookIds: [],
    errors: [],
  };

  const disk = await walkBooks(opts.booksDir);
  report.filesSeen = disk.length;
  const onDisk = new Set(disk.map((f) => f.relPath));
  const known = new Map(db.select().from(bookFiles).all().map((r) => [r.relPath, r]));
  /** Rows whose path is gone, by hash: candidates for a move. */
  const vanishedByHash = new Map<string, typeof bookFiles.$inferSelect>();
  for (const row of known.values()) {
    if (!onDisk.has(row.relPath) && row.sha256) vanishedByHash.set(row.sha256, row);
  }
  const touchedBooks = new Set<string>();

  let done = 0;
  for (const file of disk) {
    try {
      const row = known.get(file.relPath);
      if (row && row.sizeBytes === file.sizeBytes && row.mtimeMs === file.mtimeMs) {
        report.unchanged++;
      } else if (row) {
        const sha256 = await sha256File(file.absPath);
        db.update(bookFiles)
          .set({ sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs, sha256 })
          .where(eq(bookFiles.id, row.id))
          .run();
        report.updated++;
      } else {
        await addFile(opts, file, vanishedByHash, report, touchedBooks);
      }
    } catch (err) {
      report.errors.push({ relPath: file.relPath, error: err instanceof Error ? err.message : String(err) });
    }
    opts.onProgress?.(++done, disk.length);
  }

  // Remove rows for files that are gone (moves were already re-pointed above).
  const stillKnown = db.select().from(bookFiles).all();
  for (const row of stillKnown) {
    if (onDisk.has(row.relPath)) continue;
    db.delete(bookFiles).where(eq(bookFiles.id, row.id)).run();
    report.removed++;
    touchedBooks.add(row.bookId);
  }

  // Moves into a rating folder (e.g. into /books/adult) can raise a book's rating.
  for (const bookId of touchedBooks) reRateFromFolders(db, bookId);

  report.missingBookIds = db
    .select({ id: books.id })
    .from(books)
    .where(
      // ws/audio: a book with only an audiobook isn't missing its files.
      sql`${books.kindleOnly} = 0 and not exists (select 1 from ${bookFiles} where ${bookFiles.bookId} = ${books.id}) and not exists (select 1 from audiobooks where audiobooks.book_id = ${books.id})`,
    )
    .all()
    .map((r) => r.id);

  report.finishedAt = Date.now();
  return report;
}

async function addFile(
  opts: ScanOptions,
  file: DiskFile,
  vanishedByHash: Map<string, typeof bookFiles.$inferSelect>,
  report: ScanReport,
  touchedBooks: Set<string>,
): Promise<void> {
  const { db } = opts;
  const sha256 = await sha256File(file.absPath);
  const fileRow = { relPath: file.relPath, format: file.format, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs, sha256 };

  // 1. A file we knew under another path: it moved.
  const moved = vanishedByHash.get(sha256);
  if (moved) {
    vanishedByHash.delete(sha256);
    db.update(bookFiles).set(fileRow).where(eq(bookFiles.id, moved.id)).run();
    touchedBooks.add(moved.bookId);
    report.moved++;
    return;
  }

  // 2. Same bytes as a file that is still on disk: exact duplicate of that book.
  const twin = db.select().from(bookFiles).where(eq(bookFiles.sha256, sha256)).get();
  if (twin) {
    db.insert(bookFiles).values({ ...fileRow, bookId: twin.bookId }).run();
    touchedBooks.add(twin.bookId);
    report.duplicates.push({ relPath: file.relPath, sameAs: twin.relPath });
    report.attached++;
    return;
  }

  // 3. Read metadata. Another format of a book we already have?
  const { metadata, error } = await extractMetadata({ ...file, ignoreDirs: NON_AUTHOR_DIRS });
  if (error) report.errors.push({ relPath: file.relPath, error: `metadata: ${error}` });

  const sameWork = findSameWork(db, metadata);
  if (sameWork) {
    db.insert(bookFiles).values({ ...fileRow, bookId: sameWork.id }).run();
    touchedBooks.add(sameWork.id);
    report.attached++;
    return;
  }

  // 4. A new book, waiting in the inbox.
  const title = metadata.title ?? file.relPath.split("/").pop()!;
  const rating = autoRating({ relPaths: [file.relPath], metadata });
  const bookId = db.transaction((tx) => {
    const [book] = tx
      .insert(books)
      .values({
        ...bookFieldsFrom({ ...metadata, title }),
        title,
        sortTitle: bookFieldsFrom({ title }).sortTitle!,
        rating: rating?.rating ?? null,
        ratingSource: rating?.source ?? null,
        approved: false,
      })
      .returning({ id: books.id })
      .all();
    tx.insert(bookFiles).values({ ...fileRow, bookId: book!.id }).run();
    if (metadata.authors?.length) setBookAuthors(tx, book!.id, metadata.authors);
    if (metadata.series) setBookSeries(tx, book!.id, metadata.series, metadata.seriesPosition);
    addGenreTags(tx, book!.id, metadata.subjects);
    return book!.id;
  });
  report.added++;

  if (metadata.cover) {
    const coverPath = await saveCover(opts.configDir, bookId, metadata.cover).catch(() => undefined);
    if (coverPath) db.update(books).set({ coverPath }).where(eq(books.id, bookId)).run();
  }

  if (opts.online) {
    const res = await enrichBook({ db, configDir: opts.configDir, bookId, fileMetadata: metadata, lookup: opts.online });
    for (const e of res.errors) report.errors.push({ relPath: file.relPath, error: `lookup: ${e}` });
  }
}

/** Re-apply folder signals after files were added, moved or removed. Only ever raises approved books. */
function reRateFromFolders(db: Db, bookId: string): void {
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) return;
  const signal = autoRating({ relPaths: filePathsForBook(db, bookId), metadata: {} });
  if (!signal) return;
  // For inbox books, a folder signal only adds to what metadata said: never lower it here.
  const effective = { ...book, approved: true };
  if (shouldReplaceRating(effective, signal)) {
    db.update(books).set({ rating: signal.rating, ratingSource: signal.source, updatedAt: Date.now() }).where(eq(books.id, bookId)).run();
  }
}
