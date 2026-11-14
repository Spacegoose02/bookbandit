/** Authors, genre tags and series for a batch of books, in one query each. No content lock here: callers filter first. */
import { asc, eq, inArray, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, bookSeries, bookTags, series, tags } from "../db/schema.js";

export interface BookFacts {
  authors: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  series: { id: string; name: string; position: number | null }[];
}

export function bookFacts(db: Db, ids: string[]): Map<string, BookFacts> {
  const out = new Map<string, BookFacts>();
  for (const id of ids) out.set(id, { authors: [], tags: [], series: [] });
  if (!ids.length) return out;
  // SQLite caps bound parameters; chunk big batches.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db
      .select({ bookId: bookAuthors.bookId, id: authors.id, name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(and(inArray(bookAuthors.bookId, chunk), eq(bookAuthors.role, "author")))
      .orderBy(asc(bookAuthors.position))
      .all())
      out.get(r.bookId)!.authors.push({ id: r.id, name: r.name });
    for (const r of db
      .select({ bookId: bookTags.bookId, id: tags.id, name: tags.name })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      // Curated categories and the raw subjects behind them ("Dragons", "Boarding schools").
      .where(and(inArray(bookTags.bookId, chunk), inArray(tags.kind, ["genre", "subject"])))
      .all())
      out.get(r.bookId)!.tags.push({ id: r.id, name: r.name });
    for (const r of db
      .select({ bookId: bookSeries.bookId, id: series.id, name: series.name, position: bookSeries.position })
      .from(bookSeries)
      .innerJoin(series, eq(series.id, bookSeries.seriesId))
      .where(inArray(bookSeries.bookId, chunk))
      .all())
      out.get(r.bookId)!.series.push({ id: r.id, name: r.name, position: r.position });
  }
  return out;
}
