/**
 * Category browsing on top of the `tags` table (genre tags from metadata, section tags like
 * "Cookbooks", and custom tags). Counts and covers only include books the reader can see, and a
 * category with nothing visible is left out of the list and 404s on its own page.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { isCookbookCategory } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { books, bookTags, tags } from "../db/schema.js";
import { requireAdmin, requireReader } from "../auth/plugin.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import { likePattern, listBooks, SORTS } from "../catalog/list.js";
import { collapse } from "../metadata/text.js";

const KINDS = ["genre", "section", "custom"] as const;
const IdParams = z.object({ id: z.string().min(1).max(64) });
const ListQuery = z.object({
  q: z.string().max(200).optional(),
  kind: z.enum(KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  covers: z.coerce.number().int().min(0).max(6).default(3),
});
const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(SORTS).optional(),
});
const CreateBody = z.object({
  name: z.string().trim().min(1).max(60),
  /** section = gets its own home shelf (Kids, Cookbooks); custom = a household tag. */
  kind: z.enum(["section", "custom"]).default("custom"),
});
const BookIds = z.array(z.string().min(1).max(64)).max(1000);
const BooksBody = z.object({ add: BookIds.default([]), remove: BookIds.default([]) });

export async function categoryRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.get("/api/categories", async (req) => {
    const reader = requireReader(req);
    const q = ListQuery.parse(req.query);
    const n = count(books.id);
    const rows = db
      .select({ id: tags.id, name: tags.name, kind: tags.kind, bookCount: n })
      .from(tags)
      .innerJoin(bookTags, eq(bookTags.tagId, tags.id))
      .innerJoin(books, eq(books.id, bookTags.bookId))
      .where(
        and(
          visibleBooksWhere(reader),
          q.kind ? eq(tags.kind, q.kind) : undefined,
          q.q?.trim() ? sql`${tags.name} like ${likePattern(q.q.trim())} escape '\\'` : undefined,
        ),
      )
      .groupBy(tags.id)
      // Sections (Kids, Cookbooks) first, then the biggest genres.
      .orderBy(sql`${tags.kind} = 'section' desc`, desc(n), asc(sql`lower(${tags.name})`))
      .limit(q.limit)
      .all();
    const items = rows.map((t) => ({
      ...t,
      cookbook: isCookbookCategory(t.name),
      books: q.covers
        ? listBooks(db, reader, { shelf: `tag:${t.id}`, sort: "added", limit: q.covers, offset: 0 }).items
        : [],
    }));
    return { items };
  });

  app.get("/api/categories/:id", async (req) => {
    const reader = requireReader(req);
    const { id } = IdParams.parse(req.params);
    const q = PageQuery.parse(req.query);
    const tag = db.select().from(tags).where(eq(tags.id, id)).get();
    if (!tag) throw new ContentLockedError();
    const { items, total } = listBooks(db, reader, { shelf: `tag:${id}`, sort: q.sort, limit: q.limit, offset: q.offset });
    if (!total && reader.role !== "admin") throw new ContentLockedError();
    return {
      category: { id: tag.id, name: tag.name, kind: tag.kind, cookbook: isCookbookCategory(tag.name) },
      items,
      total,
      limit: q.limit,
      offset: q.offset,
    };
  });

  /** The categories of one book (for chips and the Cook mode button on the book page). */
  app.get("/api/books/:id/categories", async (req) => {
    const reader = requireReader(req);
    const { id } = IdParams.parse(req.params);
    const book = db.select({ rating: books.rating, approved: books.approved }).from(books).where(eq(books.id, id)).get();
    if (!book) throw new ContentLockedError();
    assertCanSee(reader, book);
    const items = db
      .select({ id: tags.id, name: tags.name, kind: tags.kind })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(eq(bookTags.bookId, id))
      .orderBy(sql`${tags.kind} = 'section' desc`, asc(tags.name))
      .all()
      .map((t) => ({ ...t, cookbook: isCookbookCategory(t.name) }));
    return { items, cookbook: items.some((t) => t.cookbook) };
  });

  // --- admin -----------------------------------------------------------------

  app.post("/api/categories", async (req, reply) => {
    requireAdmin(req);
    const body = CreateBody.parse(req.body);
    const name = collapse(body.name);
    db.insert(tags).values({ name, kind: body.kind }).onConflictDoNothing().run();
    const tag = db.select().from(tags).where(and(eq(tags.name, name), eq(tags.kind, body.kind))).get()!;
    reply.code(201);
    return { id: tag.id, name: tag.name, kind: tag.kind, cookbook: isCookbookCategory(tag.name) };
  });

  app.put("/api/categories/:id/books", async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const body = BooksBody.parse(req.body);
    if (!db.select({ id: tags.id }).from(tags).where(eq(tags.id, id)).get()) throw new ContentLockedError();
    const add = [...new Set(body.add)];
    if (add.length) {
      const found = db.select({ id: books.id }).from(books).where(inArray(books.id, add)).all();
      if (found.length !== add.length) throw Object.assign(new Error("Unknown book id"), { statusCode: 400 });
    }
    db.transaction((tx) => {
      for (const bookId of add) tx.insert(bookTags).values({ bookId, tagId: id }).onConflictDoNothing().run();
      if (body.remove.length)
        tx.delete(bookTags).where(and(eq(bookTags.tagId, id), inArray(bookTags.bookId, body.remove))).run();
    });
    const total = db.select({ n: count() }).from(bookTags).where(eq(bookTags.tagId, id)).get()?.n ?? 0;
    return { id, bookCount: total };
  });

  app.delete("/api/categories/:id", async (req, reply) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const res = db.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id }).all();
    if (!res.length) throw new ContentLockedError();
    reply.code(204);
  });
}
