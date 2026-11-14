import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { books } from "../db/schema.js";
import { requireReader } from "../auth/plugin.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../content/lock.js";

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function bookRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.get("/api/books", async (req) => {
    const reader = requireReader(req);
    const q = ListQuery.parse(req.query);
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
      .where(visibleBooksWhere(reader))
      .orderBy(asc(books.sortTitle))
      .limit(q.limit)
      .offset(q.offset)
      .all();
    return { items: rows, limit: q.limit, offset: q.offset };
  });

  app.get<{ Params: { id: string } }>("/api/books/:id", async (req) => {
    const reader = requireReader(req);
    const book = db.select().from(books).where(eq(books.id, req.params.id)).get();
    if (!book) throw new ContentLockedError();
    assertCanSee(reader, book);
    return book;
  });
}
