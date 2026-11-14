/** Database writes for the library: authors, series, genre tags, and book field updates. */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, books, bookSeries, bookTags, bookFiles, series, tags } from "../db/schema.js";
import type { BookMetadata } from "../metadata/types.js";
import { applySubjects } from "../discover/category-store.js";
import { authorSortName, collapse, matchKey, sortTitle } from "../metadata/text.js";
import { bookVolume, differentBooks, volumeIn } from "../metadata/volume.js";

/** Anything Drizzle can run queries on: the db itself or a transaction. */
type Tx = Pick<Db, "select" | "insert" | "update" | "delete">;

export function ensureAuthorIds(tx: Tx, names: string[]): string[] {
  const ids: string[] = [];
  for (const raw of names) {
    const name = collapse(raw);
    if (!name) continue;
    tx.insert(authors).values({ name, sortName: authorSortName(name) }).onConflictDoNothing().run();
    const row = tx.select({ id: authors.id }).from(authors).where(eq(authors.name, name)).get();
    if (row && !ids.includes(row.id)) ids.push(row.id);
  }
  return ids;
}

export function setBookAuthors(tx: Tx, bookId: string, names: string[]): void {
  const ids = ensureAuthorIds(tx, names);
  tx.delete(bookAuthors).where(and(eq(bookAuthors.bookId, bookId), eq(bookAuthors.role, "author"))).run();
  ids.forEach((authorId, position) => {
    tx.insert(bookAuthors).values({ bookId, authorId, role: "author", position }).onConflictDoNothing().run();
  });
}

/** Links the book to a series by name (case-insensitive), creating it if needed. Admin-managed links are kept. */
export function setBookSeries(tx: Tx, bookId: string, name: string, position?: number): void {
  const clean = collapse(name);
  if (!clean) return;
  const existingLinks = tx
    .select({ seriesId: bookSeries.seriesId, adminManaged: series.adminManaged })
    .from(bookSeries)
    .innerJoin(series, eq(series.id, bookSeries.seriesId))
    .where(eq(bookSeries.bookId, bookId))
    .all();
  if (existingLinks.some((l) => l.adminManaged)) return;
  let row = tx.select({ id: series.id }).from(series).where(sql`lower(${series.name}) = ${clean.toLowerCase()}`).get();
  if (!row) [row] = tx.insert(series).values({ name: clean }).returning({ id: series.id }).all();
  tx.insert(bookSeries)
    .values({ bookId, seriesId: row!.id, position: position ?? null })
    .onConflictDoNothing()
    .run();
}

/**
 * Keeps a book's useful raw subjects as `subject` tags and files it under curated categories
 * (see discover/taxonomy.ts). Before this, every subject became a category of its own.
 */
export function addGenreTags(tx: Tx, bookId: string, subjects: string[] | undefined): void {
  applySubjects(tx, bookId, subjects);
}

/** Columns of `books` we fill from metadata, only where they're empty unless `overwrite`. */
export function bookFieldsFrom(meta: BookMetadata): Partial<typeof books.$inferInsert> {
  const f: Partial<typeof books.$inferInsert> = {};
  if (meta.title) {
    f.title = meta.title;
    f.sortTitle = sortTitle(meta.title);
  }
  if (meta.subtitle) f.subtitle = meta.subtitle;
  if (meta.description) f.description = meta.description;
  if (meta.language) f.language = meta.language.slice(0, 16);
  if (meta.publishedYear) f.publishedYear = meta.publishedYear;
  if (meta.isbn13) f.isbn13 = meta.isbn13;
  if (meta.publisher) f.publisher = meta.publisher;
  if (meta.pageCount) f.pageCount = meta.pageCount;
  return f;
}

/** Only the fields that are currently empty on the book. */
export function fillGaps(
  current: typeof books.$inferSelect,
  fields: Partial<typeof books.$inferInsert>,
): Partial<typeof books.$inferInsert> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const cur = (current as Record<string, unknown>)[k];
    if ((cur == null || cur === "") && v != null) out[k] = v;
  }
  return out as Partial<typeof books.$inferInsert>;
}

/**
 * An existing book that is the same work as `meta`: same ISBN, or same sort title with an
 * overlapping author. Used to attach a second format (EPUB + PDF) to one book. Never another
 * volume of the same series ("Book 4" vs "Book 6"), and a title match never crosses ISBNs.
 */
export function findSameWork(db: Tx, meta: BookMetadata): typeof books.$inferSelect | undefined {
  const facts = { volume: meta.seriesPosition ?? (meta.title ? volumeIn(meta.title) : undefined), isbn13: meta.isbn13 };
  if (meta.isbn13) {
    const byIsbn = db.select().from(books).where(eq(books.isbn13, meta.isbn13)).all();
    const volumes = bookVolumes(db, byIsbn);
    const hit = byIsbn.find((b) => !differentBooks(facts, { volume: volumes.get(b.id) }));
    if (hit) return hit;
  }
  if (!meta.title || !meta.authors?.length) return undefined;
  const all = db.select().from(books).where(eq(books.sortTitle, sortTitle(meta.title))).all();
  const volumes = bookVolumes(db, all);
  const candidates = all.filter((c) => !differentBooks(facts, { volume: volumes.get(c.id), isbn13: c.isbn13 }));
  if (!candidates.length) return undefined;
  const wanted = new Set(meta.authors.map(matchKey));
  const links = db
    .select({ bookId: bookAuthors.bookId, name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(inArray(bookAuthors.bookId, candidates.map((c) => c.id)))
    .all();
  return candidates.find((c) => links.some((l) => l.bookId === c.id && wanted.has(matchKey(l.name))));
}

/**
 * Each book's number in its series: the series position, else a number in its title ("Book 4"),
 * else one in a file name or folder ("(Book 6)"). Pass no rows to read every book.
 */
export function bookVolumes(db: Tx, rows?: { id: string; title: string }[]): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  if (rows && !rows.length) return out;
  const ids = rows?.map((r) => r.id);
  const list = rows ?? db.select({ id: books.id, title: books.title }).from(books).all();
  const positions = new Map<string, number | null>();
  for (const r of db
    .select({ bookId: bookSeries.bookId, position: bookSeries.position })
    .from(bookSeries)
    .where(ids ? inArray(bookSeries.bookId, ids) : undefined)
    .all())
    if (r.position != null || !positions.has(r.bookId)) positions.set(r.bookId, r.position);
  const paths = new Map<string, string[]>();
  for (const r of db
    .select({ bookId: bookFiles.bookId, relPath: bookFiles.relPath })
    .from(bookFiles)
    .where(ids ? inArray(bookFiles.bookId, ids) : undefined)
    .all())
    paths.set(r.bookId, [...(paths.get(r.bookId) ?? []), r.relPath]);
  for (const b of list) out.set(b.id, bookVolume(positions.get(b.id), b.title, paths.get(b.id)));
  return out;
}

export function filePathsForBook(db: Tx, bookId: string): string[] {
  return db.select({ relPath: bookFiles.relPath }).from(bookFiles).where(eq(bookFiles.bookId, bookId)).all().map((r) => r.relPath);
}
