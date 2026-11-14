/**
 * Shared reads and file moves for the librarian tools. Admin-only views: they list books whatever
 * their rating or approval, like the inbox (an admin has to see a book to fix it).
 */
import { asc, eq, inArray, sql } from "drizzle-orm";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, bookFiles, bookmarks, books, bookSeries, bookTags, readingProgress, series, tags } from "../db/schema.js";
import { insideRoot } from "../library/serve.js";

export type BookRow = typeof books.$inferSelect;

export interface LibrarianFile {
  id: string;
  relPath: string;
  format: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface LibrarianBook {
  id: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  series: { id: string; name: string; position: number | null } | null;
  tags: { name: string; kind: string }[];
  language: string | null;
  publishedYear: number | null;
  isbn13: string | null;
  publisher: string | null;
  description: string | null;
  coverPath: string | null;
  rating: BookRow["rating"];
  ratingSource: BookRow["ratingSource"];
  approved: boolean;
  kindleOnly: boolean;
  files: LibrarianFile[];
  addedAt: number;
  updatedAt: number | null;
}

/** Full admin view of a page of books, in the order of `rows`. */
export function describeBooks(db: Db, rows: BookRow[]): LibrarianBook[] {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const authorRows = db
    .select({ bookId: bookAuthors.bookId, name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(inArray(bookAuthors.bookId, ids))
    .orderBy(asc(bookAuthors.position))
    .all();
  const fileRows = db
    .select({ bookId: bookFiles.bookId, id: bookFiles.id, relPath: bookFiles.relPath, format: bookFiles.format, sizeBytes: bookFiles.sizeBytes, sha256: bookFiles.sha256 })
    .from(bookFiles)
    .where(inArray(bookFiles.bookId, ids))
    .orderBy(asc(bookFiles.relPath))
    .all();
  const seriesRows = db
    .select({ bookId: bookSeries.bookId, id: series.id, name: series.name, position: bookSeries.position })
    .from(bookSeries)
    .innerJoin(series, eq(series.id, bookSeries.seriesId))
    .where(inArray(bookSeries.bookId, ids))
    .all();
  const tagRows = db
    .select({ bookId: bookTags.bookId, name: tags.name, kind: tags.kind })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(inArray(bookTags.bookId, ids))
    .orderBy(asc(tags.name))
    .all();
  const group = <T extends { bookId: string }>(list: T[]) => {
    const m = new Map<string, Omit<T, "bookId">[]>();
    for (const { bookId, ...rest } of list) m.set(bookId, [...(m.get(bookId) ?? []), rest]);
    return m;
  };
  const authorsBy = group(authorRows);
  const filesBy = group(fileRows);
  const seriesBy = group(seriesRows);
  const tagsBy = group(tagRows);
  return rows.map((b) => ({
    id: b.id,
    title: b.title,
    subtitle: b.subtitle,
    authors: (authorsBy.get(b.id) ?? []).map((a) => a.name),
    series: seriesBy.get(b.id)?.[0] ?? null,
    tags: tagsBy.get(b.id) ?? [],
    language: b.language,
    publishedYear: b.publishedYear,
    isbn13: b.isbn13,
    publisher: b.publisher,
    description: b.description,
    coverPath: b.coverPath,
    rating: b.rating,
    ratingSource: b.ratingSource,
    approved: b.approved,
    kindleOnly: b.kindleOnly,
    files: filesBy.get(b.id) ?? [],
    addedAt: b.addedAt,
    updatedAt: b.updatedAt,
  }));
}

/** How many people have progress or bookmarks on each book (so the admin keeps the one in use). */
export function readerCounts(db: Db, ids: string[]): Map<string, { readers: number; bookmarks: number }> {
  const out = new Map<string, { readers: number; bookmarks: number }>();
  if (!ids.length) return out;
  for (const id of ids) out.set(id, { readers: 0, bookmarks: 0 });
  for (const r of db
    .select({ bookId: readingProgress.bookId, n: sql<number>`count(*)` })
    .from(readingProgress)
    .where(inArray(readingProgress.bookId, ids))
    .groupBy(readingProgress.bookId)
    .all())
    out.get(r.bookId)!.readers = r.n;
  for (const r of db
    .select({ bookId: bookmarks.bookId, n: sql<number>`count(*)` })
    .from(bookmarks)
    .where(sql`${inArray(bookmarks.bookId, ids)} and ${bookmarks.deletedAt} is null`)
    .groupBy(bookmarks.bookId)
    .all())
    out.get(r.bookId)!.bookmarks = r.n;
  return out;
}

export function loadBooks(db: Db, ids: string[]): BookRow[] {
  if (!ids.length) return [];
  const rows = db.select().from(books).where(inArray(books.id, ids)).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is BookRow => !!r);
}

/**
 * Move a book file into a hidden folder under the books root (".duplicates", ".rejected"), which
 * scans skip. Nothing is deleted, so a mistake is undone by moving the file back. Returns the new
 * relative path, or null when the file was already gone.
 */
export async function setAside(booksRoot: string, relPath: string, folder: string): Promise<string | null> {
  const abs = insideRoot(booksRoot, relPath);
  if (!abs) return null;
  let target = insideRoot(booksRoot, join(folder, relPath));
  if (!target) return null;
  await mkdir(dirname(target), { recursive: true });
  // Don't overwrite an earlier set-aside copy with the same name.
  for (let i = 2; await exists(target); i++) {
    const t = insideRoot(booksRoot, join(folder, `${relPath}.${i}`));
    if (!t) return null;
    target = t;
  }
  try {
    await rename(abs, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return relative(booksRoot, target).split(sep).join("/");
}

async function exists(p: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  return stat(p).then(
    () => true,
    () => false,
  );
}
