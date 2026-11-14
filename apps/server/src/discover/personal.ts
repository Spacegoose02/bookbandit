/**
 * What one reader has been reading, for the personal Discover rows. Every query starts from
 * `visibleBooksWhere(reader)`, so a book the reader can't open never seeds a row either.
 */
import { and, asc, count, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, books, bookSeries, bookTags, readingProgress, series, tags } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import { enrich, type BookSummary } from "../catalog/list.js";
import { hiddenTagIds } from "./category-store.js";

export interface HistoryBook {
  id: string;
  title: string;
  finished: boolean;
  percent: number;
}

/** Books the reader has opened, most recent first (visible ones only). */
export function readingHistory(db: Db, reader: Reader, limit = 40): HistoryBook[] {
  return db
    .select({ id: books.id, title: books.title, finished: readingProgress.finished, percent: readingProgress.percent })
    .from(readingProgress)
    .innerJoin(books, eq(books.id, readingProgress.bookId))
    .where(
      and(
        eq(readingProgress.userId, reader.userId),
        or(sql`${readingProgress.percent} > 0`, eq(readingProgress.finished, true)),
        visibleBooksWhere(reader),
      ),
    )
    .orderBy(desc(readingProgress.serverUpdatedAt))
    .limit(limit)
    .all();
}

/** Seeds for "Because you read": finished or well-started books first, then whatever is recent. */
export function seedBooks(history: HistoryBook[], n: number): HistoryBook[] {
  const strong = history.filter((h) => h.finished || h.percent >= 0.25);
  const rest = history.filter((h) => !strong.includes(h));
  return [...strong, ...rest].slice(0, n);
}

/** Authors the reader comes back to, most books first. */
export function topAuthors(db: Db, bookIds: string[], n: number): string[] {
  if (!bookIds.length) return [];
  const c = count(bookAuthors.bookId);
  return db
    .select({ name: authors.name, c })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(inArray(bookAuthors.bookId, bookIds))
    .groupBy(authors.id)
    .orderBy(desc(c), asc(authors.sortName))
    .limit(n)
    .all()
    .map((r) => r.name);
}

/** Curated categories of the given books, most common first. */
export function topGenres(db: Db, bookIds: string[]): string[] {
  if (!bookIds.length) return [];
  const c = count(bookTags.bookId);
  return db
    .select({ name: tags.name, c })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(and(inArray(bookTags.bookId, bookIds), eq(tags.kind, "genre"), notInArray(tags.id, hiddenTagIds(db))))
    .groupBy(tags.id)
    .orderBy(desc(c))
    .all()
    .map((r) => r.name);
}

/** One book's raw subjects and categories, for finding similar books elsewhere. */
export function bookSubjects(db: Db, bookId: string): { subjects: string[]; genres: string[]; authors: string[] } {
  const rows = db
    .select({ name: tags.name, kind: tags.kind })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(eq(bookTags.bookId, bookId))
    .all();
  const names = db
    .select({ name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(eq(bookAuthors.bookId, bookId))
    .all();
  return {
    subjects: rows.filter((r) => r.kind === "subject").map((r) => r.name),
    genres: rows.filter((r) => r.kind === "genre").map((r) => r.name),
    authors: names.map((r) => r.name),
  };
}

/** Visible books by an author, newest first, leaving out `exclude`. */
export function booksByAuthor(db: Db, reader: Reader, name: string, exclude: Set<string>, limit: number): BookSummary[] {
  const rows = db
    .select({
      id: books.id,
      title: books.title,
      publishedYear: books.publishedYear,
      rating: books.rating,
      coverPath: books.coverPath,
      kindleOnly: books.kindleOnly,
    })
    .from(books)
    .innerJoin(bookAuthors, eq(bookAuthors.bookId, books.id))
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(and(eq(authors.name, name), visibleBooksWhere(reader)))
    .orderBy(sql`${books.publishedYear} is null`, desc(books.publishedYear))
    .limit(limit + exclude.size)
    .all()
    .filter((b) => !exclude.has(b.id))
    .slice(0, limit);
  return enrich(db, reader, rows);
}

/** Visible books in one curated category, newest additions first, leaving out `exclude`. */
export function booksInGenre(db: Db, reader: Reader, genre: string, exclude: Set<string>, limit: number): BookSummary[] {
  const rows = db
    .select({
      id: books.id,
      title: books.title,
      publishedYear: books.publishedYear,
      rating: books.rating,
      coverPath: books.coverPath,
      kindleOnly: books.kindleOnly,
    })
    .from(books)
    .innerJoin(bookTags, eq(bookTags.bookId, books.id))
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(and(eq(tags.name, genre), eq(tags.kind, "genre"), visibleBooksWhere(reader)))
    .orderBy(desc(books.addedAt))
    .limit(limit + exclude.size)
    .all()
    .filter((b) => !exclude.has(b.id))
    .slice(0, limit);
  return enrich(db, reader, rows);
}

/** Curated categories with the most books this reader can see. */
export function visibleGenres(db: Db, reader: Reader, n: number): string[] {
  const c = count(bookTags.bookId);
  return db
    .select({ name: tags.name, c })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .innerJoin(books, eq(books.id, bookTags.bookId))
    .where(and(eq(tags.kind, "genre"), visibleBooksWhere(reader), notInArray(tags.id, hiddenTagIds(db))))
    .groupBy(tags.id)
    .orderBy(desc(c))
    .limit(n)
    .all()
    .map((r) => r.name);
}

export interface SeriesProgress {
  id: string;
  name: string;
  /** Furthest numbered position the reader has opened. */
  reached: number;
  /** Visible books after that position the reader hasn't opened, in order. */
  next: (BookSummary & { position: number | null })[];
}

/** Series the reader is part-way through, most recent first. */
export function seriesInProgress(db: Db, reader: Reader, history: HistoryBook[], started: Set<string>, n: number): SeriesProgress[] {
  if (!history.length) return [];
  const order = new Map(history.map((h, i) => [h.id, i]));
  const links = db
    .select({ seriesId: bookSeries.seriesId, bookId: bookSeries.bookId, position: bookSeries.position, name: series.name })
    .from(bookSeries)
    .innerJoin(series, eq(series.id, bookSeries.seriesId))
    .where(inArray(bookSeries.bookId, history.map((h) => h.id)))
    .all();
  const bySeries = new Map<string, { name: string; reached: number; rank: number }>();
  for (const l of links) {
    const prev = bySeries.get(l.seriesId);
    const rank = order.get(l.bookId) ?? 99;
    bySeries.set(l.seriesId, {
      name: l.name,
      reached: Math.max(prev?.reached ?? 0, l.position ?? 0),
      rank: Math.min(prev?.rank ?? 99, rank),
    });
  }
  const picked = [...bySeries.entries()].sort((a, b) => a[1].rank - b[1].rank).slice(0, n);
  return picked.map(([id, s]) => {
    const rows = db
      .select({
        id: books.id,
        title: books.title,
        publishedYear: books.publishedYear,
        rating: books.rating,
        coverPath: books.coverPath,
        kindleOnly: books.kindleOnly,
        position: bookSeries.position,
      })
      .from(bookSeries)
      .innerJoin(books, eq(books.id, bookSeries.bookId))
      .where(and(eq(bookSeries.seriesId, id), visibleBooksWhere(reader)))
      .orderBy(sql`${bookSeries.position} is null`, asc(bookSeries.position))
      .all()
      .filter((b) => !started.has(b.id) && (b.position == null || b.position > s.reached));
    return { id, name: s.name, reached: s.reached, next: enrich(db, reader, rows) as SeriesProgress["next"] };
  });
}
