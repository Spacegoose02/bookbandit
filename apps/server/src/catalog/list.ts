/**
 * Book listing used by /api/books and /api/shelves. Every query starts from
 * `visibleBooksWhere(reader)`; filters only ever narrow it.
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { CONTENT_RATINGS, type ContentRating } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import {
  authors,
  bookAuthors,
  books,
  bookSeries,
  bookTags,
  collectionBooks,
  collections,
  kidShelf,
  readingProgress,
  series,
} from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";

export const SORTS = ["title", "author", "year", "added"] as const;
export type Sort = (typeof SORTS)[number];

export interface ListOptions {
  q?: string;
  authorId?: string;
  yearFrom?: number;
  yearTo?: number;
  ratings?: ContentRating[];
  shelf?: string;
  sort?: Sort;
  limit: number;
  offset: number;
}

export interface AuthorRef {
  id: string;
  name: string;
}

export interface SeriesRef {
  id: string;
  name: string;
  position: number | null;
}

export interface BookSummary {
  id: string;
  title: string;
  publishedYear: number | null;
  rating: ContentRating | null;
  coverPath: string | null;
  kindleOnly: boolean;
  authors: AuthorRef[];
  series: SeriesRef[];
  /** 0..1 when the reader has started it, else null */
  percent: number | null;
}

export class BadShelfError extends Error {
  statusCode = 400;
}

/** Escape LIKE wildcards so user text matches literally. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function parseRatings(value: string | undefined): ContentRating[] | undefined {
  if (!value) return undefined;
  const wanted = value.split(",").map((s) => s.trim());
  return CONTENT_RATINGS.filter((r) => wanted.includes(r));
}

const authorSortKey = sql`(select min(${authors.sortName}) from ${bookAuthors} join ${authors} on ${authors.id} = ${bookAuthors.authorId} where ${bookAuthors.bookId} = ${books.id})`;

/**
 * SQL for a shelf id: continue, recent, kid, series:<id>, collection:<id>, tag:<id>.
 * Returns undefined for "recent" (no narrowing, just newest first).
 */
export function shelfWhere(db: Db, reader: Reader, shelf: string): SQL | undefined {
  const [kind, id] = shelf.split(":", 2);
  switch (kind) {
    case "recent":
      return undefined;
    case "continue":
      return inArray(
        books.id,
        db
          .select({ id: readingProgress.bookId })
          .from(readingProgress)
          .where(
            and(
              eq(readingProgress.userId, reader.userId),
              eq(readingProgress.finished, false),
              gt(readingProgress.percent, 0),
            ),
          ),
      );
    case "kid":
      return inArray(
        books.id,
        db.select({ id: kidShelf.bookId }).from(kidShelf).where(eq(kidShelf.kidId, reader.userId)),
      );
    case "series":
      if (!id) break;
      return inArray(
        books.id,
        db.select({ id: bookSeries.bookId }).from(bookSeries).where(eq(bookSeries.seriesId, id)),
      );
    case "tag":
      if (!id) break;
      return inArray(books.id, db.select({ id: bookTags.bookId }).from(bookTags).where(eq(bookTags.tagId, id)));
    case "collection":
      if (!id) break;
      return inArray(
        books.id,
        db
          .select({ id: collectionBooks.bookId })
          .from(collectionBooks)
          .innerJoin(collections, eq(collections.id, collectionBooks.collectionId))
          .where(
            and(
              eq(collectionBooks.collectionId, id),
              eq(collections.householdId, reader.householdId),
              or(isNull(collections.ownerId), eq(collections.ownerId, reader.userId)),
            ),
          ),
      );
  }
  throw new BadShelfError(`Unknown shelf "${shelf}"`);
}

export function listBooks(db: Db, reader: Reader, opts: ListOptions): { items: BookSummary[]; total: number } {
  const filters: (SQL | undefined)[] = [visibleBooksWhere(reader)];

  if (opts.q?.trim()) {
    const pattern = likePattern(opts.q.trim());
    filters.push(
      or(
        sql`${books.title} like ${pattern} escape '\\'`,
        sql`exists (select 1 from ${bookAuthors} join ${authors} on ${authors.id} = ${bookAuthors.authorId} where ${bookAuthors.bookId} = ${books.id} and ${authors.name} like ${pattern} escape '\\')`,
      ),
    );
  }
  if (opts.authorId) {
    filters.push(
      inArray(
        books.id,
        db.select({ id: bookAuthors.bookId }).from(bookAuthors).where(eq(bookAuthors.authorId, opts.authorId)),
      ),
    );
  }
  if (opts.yearFrom !== undefined) filters.push(sql`${books.publishedYear} >= ${opts.yearFrom}`);
  if (opts.yearTo !== undefined) filters.push(sql`${books.publishedYear} <= ${opts.yearTo}`);
  // Narrows within what the lock allows; it can never widen it.
  if (opts.ratings) filters.push(opts.ratings.length ? inArray(books.rating, opts.ratings) : sql`0`);
  if (opts.shelf) filters.push(shelfWhere(db, reader, opts.shelf));

  const where = and(...filters);
  const sort = opts.sort ?? (opts.shelf === "recent" ? "added" : "title");
  const orderBy =
    sort === "added"
      ? [desc(books.addedAt), asc(books.sortTitle)]
      : sort === "year"
        ? [sql`${books.publishedYear} is null`, asc(books.publishedYear), asc(books.sortTitle)]
        : sort === "author"
          ? [sql`${authorSortKey} is null`, asc(authorSortKey), asc(books.sortTitle)]
          : [asc(books.sortTitle)];

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
    .where(where)
    .orderBy(...orderBy)
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  const total = db.select({ n: count() }).from(books).where(where).get()?.n ?? 0;

  return { items: enrich(db, reader, rows), total };
}

/** Add authors, series and the reader's percent to a page of books. */
export function enrich<T extends { id: string }>(
  db: Db,
  reader: Reader,
  rows: T[],
): (T & { authors: AuthorRef[]; series: SeriesRef[]; percent: number | null })[] {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];

  const authorRows = db
    .select({ bookId: bookAuthors.bookId, id: authors.id, name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(and(inArray(bookAuthors.bookId, ids), eq(bookAuthors.role, "author")))
    .orderBy(asc(bookAuthors.position))
    .all();
  const seriesRows = db
    .select({ bookId: bookSeries.bookId, id: series.id, name: series.name, position: bookSeries.position })
    .from(bookSeries)
    .innerJoin(series, eq(series.id, bookSeries.seriesId))
    .where(inArray(bookSeries.bookId, ids))
    .all();
  const progressRows = db
    .select({ bookId: readingProgress.bookId, percent: readingProgress.percent })
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, reader.userId), inArray(readingProgress.bookId, ids)))
    .all();

  const group = <R extends { bookId: string }>(list: R[]) => {
    const map = new Map<string, Omit<R, "bookId">[]>();
    for (const { bookId, ...rest } of list) {
      const arr = map.get(bookId) ?? [];
      arr.push(rest);
      map.set(bookId, arr);
    }
    return map;
  };
  const byAuthor = group(authorRows);
  const bySeries = group(seriesRows);
  const percent = new Map(progressRows.map((p) => [p.bookId, p.percent]));

  return rows.map((r) => ({
    ...r,
    authors: (byAuthor.get(r.id) ?? []) as AuthorRef[],
    series: (bySeries.get(r.id) ?? []) as SeriesRef[],
    percent: percent.get(r.id) ?? null,
  }));
}
