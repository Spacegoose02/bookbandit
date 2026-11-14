import type { FastifyInstance } from "fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, bookFiles, books } from "../db/schema.js";
import { requireReader } from "../auth/plugin.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import { enrich, likePattern, listBooks, parseRatings, SORTS } from "../catalog/list.js";
import { hasAudio } from "../audio/sources.js";

const year = z.coerce.number().int().min(0).max(3000);

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(200).optional(),
  author: z.string().max(64).optional(),
  yearFrom: year.optional(),
  yearTo: year.optional(),
  /** Comma list of ratings; intersected with what the reader may see. */
  ratings: z.string().max(100).optional(),
  /** continue | recent | kid | series:<id> | collection:<id> | tag:<id> */
  shelf: z.string().max(80).optional(),
  sort: z.enum(SORTS).optional(),
});

const AuthorQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function bookRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.get("/api/books", async (req) => {
    const reader = requireReader(req);
    const q = ListQuery.parse(req.query);
    const { items, total } = listBooks(db, reader, {
      q: q.q,
      authorId: q.author,
      yearFrom: q.yearFrom,
      yearTo: q.yearTo,
      ratings: parseRatings(q.ratings),
      shelf: q.shelf,
      sort: q.sort,
      limit: q.limit,
      offset: q.offset,
    });
    return { items, limit: q.limit, offset: q.offset, total };
  });

  app.get<{ Params: { id: string } }>("/api/books/:id", async (req) => {
    const reader = requireReader(req);
    const book = db.select().from(books).where(eq(books.id, req.params.id)).get();
    if (!book) throw new ContentLockedError();
    assertCanSee(reader, book);
    const files = db
      .select({ id: bookFiles.id, format: bookFiles.format, sizeBytes: bookFiles.sizeBytes })
      .from(bookFiles)
      .where(eq(bookFiles.bookId, book.id))
      .orderBy(asc(bookFiles.format))
      .all();
    const [enriched] = enrich(db, reader, [book]);
    // hasAudio: an Audiobookshelf link or a local audiobook (ws/audio) — the web shows "Listen".
    return { ...enriched, files, hasAudio: hasAudio(db, book) };
  });

  /** Authors with at least one book the reader can see. */
  app.get("/api/authors", async (req) => {
    const reader = requireReader(req);
    const q = AuthorQuery.parse(req.query);
    const items = db
      .selectDistinct({ id: authors.id, name: authors.name, sortName: authors.sortName })
      .from(authors)
      .innerJoin(bookAuthors, eq(bookAuthors.authorId, authors.id))
      .innerJoin(books, eq(books.id, bookAuthors.bookId))
      .where(
        and(
          visibleBooksWhere(reader),
          q.q?.trim() ? sql`${authors.name} like ${likePattern(q.q.trim())} escape '\\'` : undefined,
        ),
      )
      .orderBy(asc(authors.sortName))
      .limit(q.limit)
      .all();
    return { items: items.map(({ id, name }) => ({ id, name })) };
  });
}
