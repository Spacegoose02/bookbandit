/**
 * Which library books Barnaby may mention. Every query starts from `visibleBooksWhere(reader)`,
 * so a kid's Barnaby never hears about a book the kid can't open (CLAUDE.md rule 1).
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, books, bookTags, kidShelf, tags } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import { enrich, likePattern } from "../catalog/list.js";

export interface LibraryBook {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  description: string | null;
  tags: string[];
  percent: number | null;
}

const STOP = new Set(
  "the a an and or but of to in on for with about from what which who whom whose why how when where is are was were be been can could would should do does did i me my you your we our it its this that these those any some book books read reading like want find recommend something good please tell more story stories".split(
    " ",
  ),
);

export function searchTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)].slice(0, 8);
}

/** Up to `limit` visible books matching the message, topped up with the kid's shelf or recent additions. */
export function libraryContext(db: Db, reader: Reader, message: string, limit = 15): LibraryBook[] {
  const visible = visibleBooksWhere(reader);
  const terms = searchTerms(message);
  const picked = new Map<string, typeof books.$inferSelect>();

  if (terms.length) {
    const matches = or(
      ...terms.flatMap((t) => {
        const p = likePattern(t);
        return [
          sql`${books.title} like ${p} escape '\\'`,
          sql`${books.description} like ${p} escape '\\'`,
          sql`exists (select 1 from ${bookAuthors} join ${authors} on ${authors.id} = ${bookAuthors.authorId} where ${bookAuthors.bookId} = ${books.id} and ${authors.name} like ${p} escape '\\')`,
          sql`exists (select 1 from ${bookTags} join ${tags} on ${tags.id} = ${bookTags.tagId} where ${bookTags.bookId} = ${books.id} and ${tags.name} like ${p} escape '\\')`,
        ];
      }),
    );
    for (const b of db.select().from(books).where(and(visible, matches)).limit(limit).all()) picked.set(b.id, b);
  }

  if (picked.size < limit && reader.isKid) {
    const shelf = db
      .select({ book: books })
      .from(kidShelf)
      .innerJoin(books, eq(books.id, kidShelf.bookId))
      .where(and(eq(kidShelf.kidId, reader.userId), visible))
      .limit(limit - picked.size)
      .all();
    for (const { book } of shelf) picked.set(book.id, book);
  }
  if (picked.size < limit) {
    const recent = db
      .select()
      .from(books)
      .where(visible)
      .orderBy(desc(books.addedAt))
      .limit(limit * 2)
      .all();
    for (const b of recent) {
      if (picked.size >= limit) break;
      picked.set(b.id, b);
    }
  }
  return describe(db, reader, [...picked.values()]);
}

function describe(db: Db, reader: Reader, rows: (typeof books.$inferSelect)[]): LibraryBook[] {
  if (!rows.length) return [];
  const tagRows = db
    .select({ bookId: bookTags.bookId, name: tags.name })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(inArray(
      bookTags.bookId,
      rows.map((r) => r.id),
    ))
    .all();
  const tagsBy = new Map<string, string[]>();
  for (const t of tagRows) tagsBy.set(t.bookId, [...(tagsBy.get(t.bookId) ?? []), t.name]);
  return enrich(db, reader, rows).map((b) => ({
    id: b.id,
    title: b.title,
    authors: b.authors.map((a) => a.name),
    year: b.publishedYear,
    description: b.description ? b.description.slice(0, 280) : null,
    tags: (tagsBy.get(b.id) ?? []).slice(0, 6),
    percent: b.percent,
  }));
}

/** Books from the context list that the reply actually names, in order of appearance. */
export function booksMentioned(reply: string, candidates: LibraryBook[]): LibraryBook[] {
  const text = reply.toLowerCase();
  return candidates
    .map((b) => ({ b, at: text.indexOf(b.title.toLowerCase()) }))
    .filter((x) => x.at >= 0 && x.b.title.length >= 3)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.b)
    .slice(0, 6);
}
