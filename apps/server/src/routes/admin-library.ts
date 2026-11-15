/**
 * Admin library moderation that the admin pages need on top of library/routes.ts:
 * a dashboard overview, the unrated-books review queue, a full admin view of one book,
 * metadata editing, and merging two records of the same work.
 *
 * Everything here is admin-only (requireAdmin, CLAUDE.md rule 4). Like the inbox, these are
 * moderation tools and list books regardless of rating or approval: an admin has to see a book
 * to rate it. Reader-facing lists stay behind visibleBooksWhere.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNull, like, ne, not, or, sql } from "drizzle-orm";
import { z } from "zod";
import { BOOK_LOCK_FIELDS, CONTENT_RATINGS, type BookLockField } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import {
  aiMessages,
  authors,
  bookAuthors,
  bookFiles,
  bookRequests,
  books,
  bookSeries,
  bookTags,
  bookmarks,
  collectionBooks,
  devices,
  kidShelf,
  readingProgress,
  series,
  tags,
  users,
} from "../db/schema.js";
import { httpError, requireAdmin } from "../auth/plugin.js";
import { useAuthErrors } from "../auth/errors.js";
import { setBookAuthors } from "../library/store.js";
import { ensureTag } from "../discover/category-store.js";
import { CURATED_NAMES } from "../discover/taxonomy.js";
import { collapse, sortTitle } from "../metadata/text.js";
import { moveAudioToBook } from "../audio/files.js";
import { hasPendingRating, pendingRatings, settleRatings } from "../ai/review.js";

/**
 * "Needs a rating": books nobody has rated, plus books where Barnaby has a looser rating waiting
 * for a yes (he never loosens one on his own unless the admin trusts him to). Admin ratings are final.
 */
const needsRating = () =>
  and(
    eq(books.kindleOnly, false),
    or(isNull(books.rating), and(hasPendingRating, or(isNull(books.ratingSource), ne(books.ratingSource, "admin")))),
  );

const IdParams = z.object({ id: z.string().min(1).max(64) });
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const UnratedQuery = Page.extend({
  /** approved (default): the review queue proper. all: inbox books too. */
  scope: z.enum(["approved", "all"]).default("approved"),
});

const thisYear = () => new Date().getUTCFullYear();
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === "" ? null : s))
    .nullable()
    .optional();

export const BookPatch = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    subtitle: optText(500),
    description: optText(20_000),
    publisher: optText(200),
    language: optText(20),
    publishedYear: z
      .number()
      .int()
      .min(0)
      .refine((y) => y <= thisYear() + 2, "Not a real year")
      .nullable()
      .optional(),
    isbn13: z
      .string()
      .trim()
      .transform((s) => s.replace(/[-\s]/g, ""))
      .refine((s) => s === "" || /^\d{13}$/.test(s), "An ISBN-13 is 13 digits")
      .transform((s) => (s === "" ? null : s))
      .nullable()
      .optional(),
    authors: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    rating: z.enum(CONTENT_RATINGS).nullable().optional(),
    sortTitle: z.string().trim().min(1).max(500).optional(),
    originalTitle: optText(500),
    pageCount: z.number().int().min(1).max(100_000).nullable().optional(),
    /** The book's one series and its number; null takes it out of every series. */
    series: z
      .object({ name: z.string().trim().min(1).max(200), position: z.number().min(0).max(100_000).nullable().default(null) })
      .nullable()
      .optional(),
    /** Every category (genre) the book is in, "Fiction" / "Nonfiction" included. Replaces the old list. */
    categories: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    hardcoverId: optText(100),
    openLibraryId: optText(100),
    googleBooksId: optText(100),
    /** The full set of locked fields. Left out, every field sent in this patch gets locked. */
    locks: z.array(z.enum(BOOK_LOCK_FIELDS)).max(BOOK_LOCK_FIELDS.length).optional(),
  })
  .strict();

/** Lock name for each patch key that is a lockable field. */
const PATCH_LOCKS: Partial<Record<keyof z.infer<typeof BookPatch>, BookLockField>> = {
  title: "title",
  sortTitle: "sortTitle",
  originalTitle: "originalTitle",
  subtitle: "subtitle",
  authors: "authors",
  series: "series",
  publishedYear: "publishedYear",
  publisher: "publisher",
  isbn13: "isbn13",
  language: "language",
  pageCount: "pageCount",
  rating: "rating",
  description: "description",
  categories: "categories",
};

const MergeBody = z.object({ intoId: z.string().min(1).max(64) }).strict();

type BookRow = typeof books.$inferSelect;

export async function adminLibraryRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  useAuthErrors(app);

  const count = (q: { n: number } | undefined) => q?.n ?? 0;

  function authorsFor(ids: string[]): Map<string, string[]> {
    const by = new Map<string, string[]>();
    if (!ids.length) return by;
    const rows = db
      .select({ bookId: bookAuthors.bookId, name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(inArray(bookAuthors.bookId, ids))
      .orderBy(asc(bookAuthors.position))
      .all();
    for (const r of rows) by.set(r.bookId, [...(by.get(r.bookId) ?? []), r.name]);
    return by;
  }

  function filesFor(ids: string[]) {
    const by = new Map<string, { id: string; relPath: string; format: string; sizeBytes: number }[]>();
    if (!ids.length) return by;
    const rows = db
      .select({ bookId: bookFiles.bookId, id: bookFiles.id, relPath: bookFiles.relPath, format: bookFiles.format, sizeBytes: bookFiles.sizeBytes })
      .from(bookFiles)
      .where(inArray(bookFiles.bookId, ids))
      .all();
    for (const { bookId, ...f } of rows) by.set(bookId, [...(by.get(bookId) ?? []), f]);
    return by;
  }

  function adminBook(b: BookRow, authorsBy: Map<string, string[]>, filesBy: ReturnType<typeof filesFor>) {
    return {
      id: b.id,
      title: b.title,
      sortTitle: b.sortTitle,
      originalTitle: b.originalTitle,
      subtitle: b.subtitle,
      authors: authorsBy.get(b.id) ?? [],
      description: b.description,
      publisher: b.publisher,
      language: b.language,
      publishedYear: b.publishedYear,
      isbn13: b.isbn13,
      coverPath: b.coverPath,
      pageCount: b.pageCount,
      rating: b.rating,
      ratingSource: b.ratingSource,
      approved: b.approved,
      kindleOnly: b.kindleOnly,
      hardcoverId: b.hardcoverId,
      openLibraryId: b.openLibraryId,
      googleBooksId: b.googleBooksId,
      lockedFields: b.lockedFields ?? [],
      files: filesBy.get(b.id) ?? [],
      addedAt: b.addedAt,
      updatedAt: b.updatedAt,
    };
  }

  function loadBook(id: string): BookRow {
    const b = db.select().from(books).where(eq(books.id, id)).get();
    if (!b) throw httpError(404, "Not found");
    return b;
  }

  function oneBook(id: string) {
    const b = loadBook(id);
    const tagRows = db
      .select({ name: tags.name, kind: tags.kind })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(eq(bookTags.bookId, id))
      .all();
    const seriesRows = db
      .select({ id: series.id, name: series.name, position: bookSeries.position })
      .from(bookSeries)
      .innerJoin(series, eq(series.id, bookSeries.seriesId))
      .where(eq(bookSeries.bookId, id))
      .all();
    return { ...adminBook(b, authorsFor([id]), filesFor([id])), tags: tagRows, series: seriesRows };
  }

  // --- Overview ---------------------------------------------------------------

  /** Counts for the admin dashboard tiles. */
  app.get("/api/admin/overview", async (req) => {
    const reader = requireAdmin(req);
    const hh = reader.householdId;
    const people = db
      .select({ role: users.role, n: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.householdId, hh), eq(users.disabled, false)))
      .groupBy(users.role)
      .all();
    const byRole = Object.fromEntries(people.map((p) => [p.role, p.n])) as Record<string, number>;
    return {
      inbox: count(db.select({ n: sql<number>`count(*)` }).from(books).where(eq(books.approved, false)).get()),
      unrated: count(
        db
          .select({ n: sql<number>`count(*)` })
          .from(books)
          .where(and(eq(books.approved, true), needsRating()))
          .get(),
      ),
      books: count(db.select({ n: sql<number>`count(*)` }).from(books).where(eq(books.approved, true)).get()),
      people: {
        grownUps: (byRole.admin ?? 0) + (byRole.parent ?? 0) + (byRole.adult ?? 0),
        kids: byRole.kid ?? 0,
      },
      devices: count(
        db
          .select({ n: sql<number>`count(*)` })
          .from(devices)
          .where(and(eq(devices.householdId, hh), isNull(devices.revokedAt), not(like(devices.tokenHash, "pair:%"))))
          .get(),
      ),
      pendingRequests: count(
        db
          .select({ n: sql<number>`count(*)` })
          .from(bookRequests)
          .innerJoin(users, eq(users.id, bookRequests.requestedBy))
          .where(and(eq(bookRequests.status, "pending"), eq(users.householdId, hh)))
          .get(),
      ),
    };
  });

  // --- Unrated review queue ----------------------------------------------------

  app.get("/api/admin/review/unrated", async (req) => {
    requireAdmin(req);
    const q = UnratedQuery.parse(req.query);
    const where = and(needsRating(), q.scope === "approved" ? eq(books.approved, true) : undefined);
    const rows = db.select().from(books).where(where).orderBy(desc(books.addedAt), asc(books.sortTitle)).limit(q.limit).offset(q.offset).all();
    const total = count(db.select({ n: sql<number>`count(*)` }).from(books).where(where).get());
    const ids = rows.map((r) => r.id);
    const authorsBy = authorsFor(ids);
    const filesBy = filesFor(ids);
    const ratingsBy = pendingRatings(db, ids);
    return {
      items: rows.map((b) => ({ ...adminBook(b, authorsBy, filesBy), barnaby: { rating: ratingsBy.get(b.id) ?? null } })),
      total,
      limit: q.limit,
      offset: q.offset,
    };
  });

  // --- One book -----------------------------------------------------------------

  app.get("/api/admin/books/:id", async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    return oneBook(id);
  });

  /** Edit metadata (and optionally the rating) from the inbox or the review queue. */
  app.patch("/api/admin/books/:id", async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const body = BookPatch.parse(req.body);
    const before = loadBook(id);
    const set: Partial<typeof books.$inferInsert> = { updatedAt: Date.now() };
    if (body.title !== undefined) {
      set.title = collapse(body.title);
      // The sort title follows the title unless it was set (or locked) by hand.
      if (body.sortTitle === undefined && !(body.locks ?? before.lockedFields ?? []).includes("sortTitle")) set.sortTitle = sortTitle(set.title);
    }
    if (body.sortTitle !== undefined) set.sortTitle = collapse(body.sortTitle);
    for (const k of ["subtitle", "originalTitle", "description", "publisher", "language", "publishedYear", "isbn13", "pageCount", "hardcoverId", "openLibraryId", "googleBooksId"] as const) {
      if (body[k] !== undefined) (set as Record<string, unknown>)[k] = body[k];
    }
    if (body.rating !== undefined) {
      set.rating = body.rating;
      set.ratingSource = body.rating ? "admin" : null;
    }
    const edited = (Object.keys(body) as (keyof typeof body)[]).map((k) => PATCH_LOCKS[k]).filter((f): f is BookLockField => !!f);
    set.lockedFields = body.locks ?? [...new Set([...(before.lockedFields ?? []), ...edited])];
    db.transaction((tx) => {
      tx.update(books).set(set).where(eq(books.id, id)).run();
      if (body.authors) setBookAuthors(tx, id, body.authors);
      if (body.series !== undefined) {
        tx.delete(bookSeries).where(eq(bookSeries.bookId, id)).run();
        if (body.series) {
          const name = collapse(body.series.name);
          let row = tx.select({ id: series.id }).from(series).where(sql`lower(${series.name}) = ${name.toLowerCase()}`).get();
          if (!row) [row] = tx.insert(series).values({ name }).returning({ id: series.id }).all();
          tx.insert(bookSeries).values({ bookId: id, seriesId: row!.id, position: body.series.position }).run();
        }
      }
      if (body.categories) {
        const keep = new Set(body.categories.map((n) => ensureTag(tx, collapse(n), "genre")));
        const current = tx
          .select({ id: tags.id })
          .from(bookTags)
          .innerJoin(tags, eq(tags.id, bookTags.tagId))
          .where(and(eq(bookTags.bookId, id), eq(tags.kind, "genre")))
          .all()
          .map((t) => t.id);
        const drop = current.filter((t) => !keep.has(t));
        if (drop.length) tx.delete(bookTags).where(and(eq(bookTags.bookId, id), inArray(bookTags.tagId, drop))).run();
        for (const tagId of keep) tx.insert(bookTags).values({ bookId: id, tagId }).onConflictDoNothing().run();
      }
    });
    if (body.rating !== undefined) settleRatings(db, [id], body.rating);
    return oneBook(id);
  });

  /** Category names for the book editor: the curated list plus any an admin made or renamed. */
  app.get("/api/admin/category-names", async (req) => {
    requireAdmin(req);
    const made = db.select({ name: tags.name }).from(tags).where(eq(tags.kind, "genre")).all().map((t) => t.name);
    return { names: [...new Set([...CURATED_NAMES, ...made])].sort((a, b) => a.localeCompare(b)) };
  });

  /**
   * Merge this book into another record of the same work. Files, shelves, tags, collections,
   * bookmarks and reading progress (newest wins) move to the target; the target keeps its own
   * metadata and fills only the gaps. Files keep their paths, so a rescan keeps them merged.
   */
  app.post("/api/admin/books/:id/merge", async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const { intoId } = MergeBody.parse(req.body);
    if (id === intoId) throw httpError(400, "Pick a different book to merge into");
    loadBook(id);
    loadBook(intoId);
    mergeBooks(db, id, intoId);
    return { merged: id, into: oneBook(intoId) };
  });
}

/**
 * Merge book `id` into `intoId` (another record of the same work). Files, shelves, tags,
 * collections, bookmarks and reading progress (newest wins) move to the target; the target keeps
 * its own metadata and fills only the gaps. Exported for the librarian duplicates page.
 */
export function mergeBooks(db: Db, id: string, intoId: string): void {
  const source = db.select().from(books).where(eq(books.id, id)).get();
  const target = db.select().from(books).where(eq(books.id, intoId)).get();
  if (!source || !target) throw httpError(404, "Not found");

  db.transaction((tx) => {
    tx.update(bookFiles).set({ bookId: intoId }).where(eq(bookFiles.bookId, id)).run();

    if (!tx.select().from(bookAuthors).where(eq(bookAuthors.bookId, intoId)).get()) {
      for (const r of tx.select().from(bookAuthors).where(eq(bookAuthors.bookId, id)).all()) {
        tx.insert(bookAuthors).values({ ...r, bookId: intoId }).onConflictDoNothing().run();
      }
    }
    for (const r of tx.select().from(bookTags).where(eq(bookTags.bookId, id)).all()) {
      tx.insert(bookTags).values({ ...r, bookId: intoId }).onConflictDoNothing().run();
    }
    if (!tx.select().from(bookSeries).where(eq(bookSeries.bookId, intoId)).get()) {
      for (const r of tx.select().from(bookSeries).where(eq(bookSeries.bookId, id)).all()) {
        tx.insert(bookSeries).values({ ...r, bookId: intoId }).onConflictDoNothing().run();
      }
    }
    for (const r of tx.select().from(kidShelf).where(eq(kidShelf.bookId, id)).all()) {
      tx.insert(kidShelf).values({ ...r, bookId: intoId }).onConflictDoNothing().run();
    }
    for (const r of tx.select().from(collectionBooks).where(eq(collectionBooks.bookId, id)).all()) {
      tx.insert(collectionBooks).values({ ...r, bookId: intoId }).onConflictDoNothing().run();
    }
    for (const p of tx.select().from(readingProgress).where(eq(readingProgress.bookId, id)).all()) {
      const existing = tx
        .select()
        .from(readingProgress)
        .where(and(eq(readingProgress.userId, p.userId), eq(readingProgress.bookId, intoId)))
        .get();
      if (!existing) tx.insert(readingProgress).values({ ...p, bookId: intoId }).run();
      else if (p.clientUpdatedAt > existing.clientUpdatedAt) {
        const { userId: _u, bookId: _b, ...rest } = p;
        tx.update(readingProgress)
          .set(rest)
          .where(and(eq(readingProgress.userId, p.userId), eq(readingProgress.bookId, intoId)))
          .run();
      }
    }
    tx.update(bookmarks).set({ bookId: intoId, updatedAt: Date.now() }).where(eq(bookmarks.bookId, id)).run();
    tx.update(aiMessages).set({ bookId: intoId }).where(eq(aiMessages.bookId, id)).run();
    moveAudioToBook(tx, id, intoId); // ws/audio: audiobooks, listening positions and bookmarks

    // Fill gaps on the target; never overwrite what it already has.
    const gaps: Partial<typeof books.$inferInsert> = { updatedAt: Date.now() };
    const fill = ["subtitle", "description", "language", "publishedYear", "isbn13", "publisher", "coverPath", "pageCount", "absItemId", "hardcoverId", "openLibraryId", "googleBooksId", "kindleAsin"] as const;
    for (const k of fill) {
      if (target[k] == null && source[k] != null) (gaps as Record<string, unknown>)[k] = source[k];
    }
    if (target.rating == null && source.rating != null) {
      gaps.rating = source.rating;
      gaps.ratingSource = source.ratingSource;
    }
    if (!target.approved && source.approved) gaps.approved = true;
    if (target.kindleOnly && !source.kindleOnly) gaps.kindleOnly = false;
    tx.update(books).set(gaps).where(eq(books.id, intoId)).run();

    tx.delete(books).where(eq(books.id, id)).run();
  });
}
