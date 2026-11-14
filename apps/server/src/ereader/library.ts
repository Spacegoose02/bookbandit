/**
 * Book access shared by OPDS, KOReader and Kobo. Everything here takes the reader and goes
 * through the content lock, so the protocol code can't forget it.
 */
import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { ReadingLocator } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { bookFiles, books, readingProgress } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import { insideRoot } from "../library/serve.js";

export type BookRow = typeof books.$inferSelect;
export type FileRow = typeof bookFiles.$inferSelect;

/** A book the reader may see, or a ContentLockedError (404) — missing and locked look the same. */
export function loadVisibleBook(db: Db, reader: Reader, bookId: string): BookRow {
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) throw new ContentLockedError();
  assertCanSee(reader, book);
  return book;
}

/** Files of books the reader may see, for a set of file ids. */
export function visibleFiles(db: Db, reader: Reader, fileIds: string[]): { file: FileRow; book: BookRow }[] {
  if (!fileIds.length) return [];
  return db
    .select({ file: bookFiles, book: books })
    .from(bookFiles)
    .innerJoin(books, eq(books.id, bookFiles.bookId))
    .where(and(inArray(bookFiles.id, fileIds), visibleBooksWhere(reader)))
    .all();
}

/** Files of a set of books, grouped by book id (callers have already applied the lock). */
export function filesByBook(db: Db, bookIds: string[]): Map<string, FileRow[]> {
  const map = new Map<string, FileRow[]>();
  if (!bookIds.length) return map;
  for (const f of db.select().from(bookFiles).where(inArray(bookFiles.bookId, bookIds)).all()) {
    const list = map.get(f.bookId) ?? [];
    list.push(f);
    map.set(f.bookId, list);
  }
  return map;
}

export function absolutePath(booksDir: string, file: FileRow): string | undefined {
  return insideRoot(resolve(booksDir), file.relPath);
}

export interface MirroredProgress {
  locator: ReadingLocator;
  percent: number;
  finished?: boolean;
  deviceName: string;
}

/**
 * Write a position from an e-reader into reading_progress with the sync API's rule: newest
 * wins by the client's clock, clamped to the server's. Returns false when a newer one is kept.
 */
export function mirrorProgress(db: Db, userId: string, bookId: string, p: MirroredProgress, clientTime: number, now = Date.now()): boolean {
  const clientUpdatedAt = Math.min(clientTime, now);
  const current = db
    .select()
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, userId), eq(readingProgress.bookId, bookId)))
    .get();
  if (current && current.clientUpdatedAt >= clientUpdatedAt) return false;
  const percent = Math.min(1, Math.max(0, Number.isFinite(p.percent) ? p.percent : 0));
  const values = {
    locator: p.locator,
    percent,
    finished: p.finished ?? percent >= 0.99,
    deviceName: p.deviceName.slice(0, 80),
    clientUpdatedAt,
    serverUpdatedAt: now,
  };
  db.insert(readingProgress)
    .values({ userId, bookId, ...values })
    .onConflictDoUpdate({ target: [readingProgress.userId, readingProgress.bookId], set: values })
    .run();
  return true;
}

export function currentProgress(db: Db, userId: string, bookId: string) {
  return db
    .select()
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, userId), eq(readingProgress.bookId, bookId)))
    .get();
}
