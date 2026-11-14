/**
 * Category browsing on top of the `tags` table (curated genre categories, section tags like
 * "Cookbooks", and custom tags; raw `subject` tags from metadata are never listed). Counts and
 * covers only include books the reader can see, and a category with nothing visible is left out of
 * the list and 404s on its own page. Genre categories with fewer than the admin's minimum of
 * visible books, and categories an admin hid, are left out of the list too.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, count, desc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { isCookbookCategory } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { books, bookTags, tags } from "../db/schema.js";
import { requireAdmin, requireReader } from "../auth/plugin.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import { likePattern, listBooks, SORTS } from "../catalog/list.js";
import { collapse } from "../metadata/text.js";
import { categoryAliases, categoryPrefs } from "./schema.js";
import {
  CategoryConflict,
  getMinBooks,
  hiddenTagIds,
  mergeTag,
  rebuildCategories,
  renameTag,
  setHidden,
  setMinBooks,
  upgradeCategories,
} from "./category-store.js";
import { CURATED_NAMES } from "./taxonomy.js";

const KINDS = ["genre", "section", "custom"] as const;
const ALL_KINDS = ["genre", "subject", "section", "custom"] as const;
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
const AdminListQuery = z.object({
  q: z.string().max(200).optional(),
  /** "categories" = everything but raw subjects. */
  kind: z.enum([...ALL_KINDS, "all", "categories"]).default("all"),
  limit: z.coerce.number().int().min(1).max(5000).default(2000),
});
const PatchBody = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    hidden: z.boolean().optional(),
    /** Promote a subject to a category, or demote a category to a plain subject. */
    kind: z.enum(["genre", "subject"]).optional(),
  })
  .refine((b) => b.name !== undefined || b.hidden !== undefined || b.kind !== undefined, "Nothing to change");
const MergeBody = z.object({ into: z.string().min(1).max(64) });
const SettingsBody = z.object({ minBooks: z.number().int().min(1).max(100) });

export async function categoryRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  // Libraries scanned before categories were curated: turn the old per-subject categories into
  // subjects and file every book under the curated list. Once, and without dropping any book link.
  const upgraded = upgradeCategories(db);
  if (upgraded && (upgraded.subjects || upgraded.linked)) app.log.info({ categories: upgraded }, "categories: tidied old genre tags");

  app.get("/api/categories", async (req) => {
    const reader = requireReader(req);
    const q = ListQuery.parse(req.query);
    const n = count(books.id);
    const minBooks = getMinBooks(db);
    const rows = db
      .select({ id: tags.id, name: tags.name, kind: tags.kind, bookCount: n })
      .from(tags)
      .innerJoin(bookTags, eq(bookTags.tagId, tags.id))
      .innerJoin(books, eq(books.id, bookTags.bookId))
      .where(
        and(
          visibleBooksWhere(reader),
          q.kind ? eq(tags.kind, q.kind) : ne(tags.kind, "subject"),
          notInArray(tags.id, hiddenTagIds(db)),
          q.q?.trim() ? sql`${tags.name} like ${likePattern(q.q.trim())} escape '\\'` : undefined,
        ),
      )
      .groupBy(tags.id)
      // A genre with only a book or two isn't worth a tile; sections and household tags always are.
      .having(or(ne(tags.kind, "genre"), sql`${n} >= ${minBooks}`))
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
      .where(and(eq(bookTags.bookId, id), ne(tags.kind, "subject"), notInArray(tags.id, hiddenTagIds(db))))
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

  /** Every tag with its total book count (no lock: admins see everything), for the manage page. */
  app.get("/api/admin/categories", async (req) => {
    requireAdmin(req);
    const q = AdminListQuery.parse(req.query);
    const n = sql<number>`(select count(*) from book_tags where tag_id = ${tags.id})`;
    const rows = db
      .select({ id: tags.id, name: tags.name, kind: tags.kind, bookCount: n, hidden: sql<number>`coalesce(${categoryPrefs.hidden}, 0)` })
      .from(tags)
      .leftJoin(categoryPrefs, eq(categoryPrefs.tagId, tags.id))
      .where(
        and(
          q.kind === "all" ? undefined : q.kind === "categories" ? ne(tags.kind, "subject") : eq(tags.kind, q.kind),
          q.q?.trim() ? sql`${tags.name} like ${likePattern(q.q.trim())} escape '\\'` : undefined,
        ),
      )
      .orderBy(desc(n), asc(sql`lower(${tags.name})`))
      .limit(q.limit)
      .all();
    const aliases = db.select().from(categoryAliases).all();
    const aliasesBy = new Map<string, string[]>();
    for (const a of aliases) aliasesBy.set(a.tagId, [...(aliasesBy.get(a.tagId) ?? []), a.key]);
    const curated = new Set(CURATED_NAMES);
    const minBooks = getMinBooks(db);
    const counts = db
      .select({ kind: tags.kind, n: count() })
      .from(tags)
      .groupBy(tags.kind)
      .all();
    return {
      items: rows.map((r) => ({
        ...r,
        hidden: !!r.hidden,
        curated: r.kind === "genre" && curated.has(r.name),
        /** What the Categories page does with it. */
        shown: !r.hidden && r.kind !== "subject" && (r.kind !== "genre" || r.bookCount >= minBooks),
        aliases: aliasesBy.get(r.id) ?? [],
      })),
      counts: Object.fromEntries(counts.map((c) => [c.kind, c.n])),
      minBooks,
    };
  });

  app.put("/api/admin/categories/settings", async (req) => {
    requireAdmin(req);
    const body = SettingsBody.parse(req.body);
    setMinBooks(db, body.minBooks);
    return { minBooks: body.minBooks };
  });

  /** Re-files every book from its subjects (only adds links; merges, renames and hides are kept). */
  app.post("/api/admin/categories/rebuild", async (req) => {
    requireAdmin(req);
    return rebuildCategories(db);
  });

  /** Rename (merging into a same-named category if there is one), hide or show, promote or demote. */
  app.patch("/api/categories/:id", async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const body = PatchBody.parse(req.body);
    const tag = db.select().from(tags).where(eq(tags.id, id)).get();
    if (!tag) throw new ContentLockedError();
    const result = db.transaction((tx) => {
      let target = id;
      if (body.kind && body.kind !== tag.kind) {
        if (tag.kind !== "genre" && tag.kind !== "subject")
          throw new CategoryConflict("Only categories and subjects can be promoted or demoted");
        const clash = tx.select({ id: tags.id }).from(tags).where(and(eq(tags.name, tag.name), eq(tags.kind, body.kind))).get();
        if (clash) {
          mergeTag(tx, id, clash.id);
          target = clash.id;
        } else tx.update(tags).set({ kind: body.kind }).where(eq(tags.id, id)).run();
      }
      if (body.name !== undefined) target = renameTag(tx, target, collapse(body.name));
      if (body.hidden !== undefined) setHidden(tx, target, body.hidden);
      return tx.select().from(tags).where(eq(tags.id, target)).get()!;
    });
    return { id: result.id, name: result.name, kind: result.kind, merged: result.id !== id };
  });

  /** Moves every book to another category and deletes this one; its name keeps pointing there. */
  app.post("/api/categories/:id/merge", async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const { into } = MergeBody.parse(req.body);
    if (id === into) throw new CategoryConflict("Can't merge a category into itself");
    const both = db.select({ id: tags.id }).from(tags).where(inArray(tags.id, [id, into])).all();
    if (both.length !== 2) throw new ContentLockedError();
    db.transaction((tx) => mergeTag(tx, id, into));
    const total = db.select({ n: count() }).from(bookTags).where(eq(bookTags.tagId, into)).get()?.n ?? 0;
    return { id: into, bookCount: total };
  });

  app.delete("/api/categories/:id", async (req, reply) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const res = db.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id }).all();
    if (!res.length) throw new ContentLockedError();
    reply.code(204);
  });
}
