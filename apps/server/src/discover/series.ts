/**
 * Series pages and admin series editing.
 *
 * Readers: GET /api/series lists series with at least one book they can see, GET /api/series/:id
 * returns one in reading order. A series whose books are all locked is a 404 (CLAUDE.md rule 1).
 *
 * Admins: create, rename, reorder (the whole ordered list at once, from drag and drop) and delete.
 * Editing marks the series adminManaged so a rescan or metadata refresh keeps the admin's version.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { books, bookSeries, series } from "../db/schema.js";
import { requireAdmin, requireReader } from "../auth/plugin.js";
import type { Reader } from "../auth/reader.js";
import { ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import { enrich, likePattern, type BookSummary } from "../catalog/list.js";
import { collapse } from "../metadata/text.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const ListQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /** How many covers to include per series for the tile. */
  covers: z.coerce.number().int().min(0).max(8).default(4),
});
const Name = z.string().trim().min(1).max(200);
const Description = z.string().trim().max(5000).nullable();
const Entries = z
  .array(
    z.object({
      bookId: z.string().min(1).max(64),
      /** Defaults to the place in the list (1, 2, 3 …). Use 1.5 for novellas between books. */
      position: z.number().min(0).max(100000).nullable().optional(),
    }),
  )
  .max(1000);
const CreateBody = z.object({ name: Name, description: Description.optional(), books: Entries.optional() });
const PatchBody = z.object({ name: Name.optional(), description: Description.optional() });
const BooksBody = z.object({ books: Entries });

export interface SeriesBook extends BookSummary {
  position: number | null;
}

/** Reading order: position (gaps allowed), then unnumbered books by year and title. */
const ORDER = [sql`${bookSeries.position} is null`, asc(bookSeries.position), sql`${books.publishedYear} is null`, asc(books.publishedYear), asc(books.sortTitle)];

export function seriesBooks(db: Db, reader: Reader, seriesId: string, limit?: number): SeriesBook[] {
  const q = db
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
    .where(and(eq(bookSeries.seriesId, seriesId), visibleBooksWhere(reader)))
    .orderBy(...ORDER);
  const rows = limit ? q.limit(limit).all() : q.all();
  return enrich(db, reader, rows);
}

export async function seriesRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.get("/api/series", async (req) => {
    const reader = requireReader(req);
    const q = ListQuery.parse(req.query);
    const where = and(
      visibleBooksWhere(reader),
      q.q?.trim() ? sql`${series.name} like ${likePattern(q.q.trim())} escape '\\'` : undefined,
    );
    const visibleCount = count(books.id);
    const base = db
      .select({
        id: series.id,
        name: series.name,
        description: series.description,
        adminManaged: series.adminManaged,
        bookCount: visibleCount,
      })
      .from(series)
      .innerJoin(bookSeries, eq(bookSeries.seriesId, series.id))
      .innerJoin(books, eq(books.id, bookSeries.bookId))
      .where(where)
      .groupBy(series.id);
    const rows = base
      .orderBy(desc(visibleCount), asc(sql`lower(${series.name})`))
      .limit(q.limit)
      .offset(q.offset)
      .all();
    const total =
      db
        .select({ n: sql<number>`count(distinct ${series.id})` })
        .from(series)
        .innerJoin(bookSeries, eq(bookSeries.seriesId, series.id))
        .innerJoin(books, eq(books.id, bookSeries.bookId))
        .where(where)
        .get()?.n ?? 0;
    const items = rows.map((s) => ({ ...s, books: q.covers ? seriesBooks(db, reader, s.id, q.covers) : [] }));
    return { items, total, limit: q.limit, offset: q.offset };
  });

  app.get("/api/series/:id", async (req) => {
    const reader = requireReader(req);
    const { id } = IdParams.parse(req.params);
    const s = db.select().from(series).where(eq(series.id, id)).get();
    if (!s) throw new ContentLockedError();
    const items = seriesBooks(db, reader, id);
    // Empty to this reader: either really empty (admins may still edit it) or all locked.
    if (!items.length && reader.role !== "admin") throw new ContentLockedError();
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      adminManaged: s.adminManaged,
      books: items,
    };
  });

  // --- admin -----------------------------------------------------------------

  /** Replace a series' book list, in the given order. */
  function setBooks(seriesId: string, entries: z.infer<typeof Entries>): void {
    const ids = [...new Set(entries.map((e) => e.bookId))];
    if (ids.length) {
      const found = db.select({ id: books.id }).from(books).where(inArray(books.id, ids)).all();
      if (found.length !== ids.length) {
        const missing = ids.filter((i) => !found.some((f) => f.id === i));
        throw Object.assign(new Error(`Unknown book ids: ${missing.join(", ")}`), { statusCode: 400 });
      }
    }
    db.transaction((tx) => {
      tx.delete(bookSeries).where(eq(bookSeries.seriesId, seriesId)).run();
      const seen = new Set<string>();
      entries.forEach((e, i) => {
        if (seen.has(e.bookId)) return;
        seen.add(e.bookId);
        tx.insert(bookSeries)
          .values({ seriesId, bookId: e.bookId, position: e.position === undefined ? i + 1 : e.position })
          .run();
      });
      tx.update(series).set({ adminManaged: true }).where(eq(series.id, seriesId)).run();
    });
  }

  app.post("/api/series", async (req, reply) => {
    requireAdmin(req);
    const body = CreateBody.parse(req.body);
    const [row] = db
      .insert(series)
      .values({ name: collapse(body.name), description: body.description ?? null, adminManaged: true })
      .returning()
      .all();
    if (body.books?.length) setBooks(row!.id, body.books);
    reply.code(201);
    return { id: row!.id, name: row!.name, description: row!.description, adminManaged: true };
  });

  app.patch("/api/series/:id", async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const body = PatchBody.parse(req.body);
    const patch: Partial<typeof series.$inferInsert> = { adminManaged: true };
    if (body.name !== undefined) patch.name = collapse(body.name);
    if (body.description !== undefined) patch.description = body.description || null;
    const [row] = db.update(series).set(patch).where(eq(series.id, id)).returning().all();
    if (!row) throw new ContentLockedError();
    return { id: row.id, name: row.name, description: row.description, adminManaged: row.adminManaged };
  });

  app.put("/api/series/:id/books", async (req) => {
    const admin = requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const body = BooksBody.parse(req.body);
    if (!db.select({ id: series.id }).from(series).where(eq(series.id, id)).get()) throw new ContentLockedError();
    setBooks(id, body.books);
    return { id, books: seriesBooks(db, admin, id) };
  });

  app.delete("/api/series/:id", async (req, reply) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const res = db.delete(series).where(eq(series.id, id)).returning({ id: series.id }).all();
    if (!res.length) throw new ContentLockedError();
    reply.code(204);
  });
}
