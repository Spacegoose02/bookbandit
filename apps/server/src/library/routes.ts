/**
 * Admin library API: scanning, the ingest inbox, ratings, metadata refresh and duplicates.
 *
 * Everything here is admin-only (requireAdmin). These are moderation tools, so they list
 * books regardless of rating or approval: an admin has to see a book to rate or reject it.
 * Reader-facing book lists stay in routes/books.ts behind visibleBooksWhere.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CONTENT_RATINGS } from "@bookbandit/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, bookFiles, books } from "../db/schema.js";
import { requireAdmin } from "../auth/plugin.js";
import type { LookupOptions } from "../metadata/lookup.js";
import { LibraryService } from "./service.js";
import { enrichBook } from "./enrich.js";
import { insideRoot, serveRoutes } from "./serve.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const Page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const Rating = z.enum(CONTENT_RATINGS);
const ApproveBody = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(1000),
  /** Optional admin rating applied to every approved book. */
  rating: Rating.optional(),
});
const ApproveOneBody = z.object({ rating: Rating.optional() }).default({});
const RejectBody = z
  .object({
    /** false (default): move files to BOOKS_DIR/.rejected so a rescan ignores them. true: delete them. */
    deleteFiles: z.boolean().default(false),
  })
  .default({});
const RatingBody = z.object({ rating: Rating.nullable() });

export interface LibraryRouteOptions {
  db: Db;
  config: Config;
  /** Tests inject a fake fetch; defaults to global fetch. */
  lookup?: LookupOptions;
  /**
   * Current lookup settings, read on each use so the admin settings page applies without a
   * restart (routes/admin-settings.ts). Defaults to the env vars.
   */
  resolveLookup?: () => LookupOptions | false;
}

/** zod parse that answers 400 instead of a 500 on bad input. */
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const err = new Error(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return r.data;
}

function notFound(): Error {
  const err = new Error("Not found") as Error & { statusCode: number };
  err.statusCode = 404;
  return err;
}

export async function libraryRoutes(app: FastifyInstance, opts: LibraryRouteOptions) {
  const { db, config } = opts;
  const currentLookup: () => LookupOptions | false =
    opts.resolveLookup ??
    (() =>
      config.METADATA_ONLINE
        ? { googleApiKey: config.GOOGLE_BOOKS_API_KEY, hardcoverToken: config.HARDCOVER_API_TOKEN, ...opts.lookup }
        : false);
  const booksRoot = resolve(config.BOOKS_DIR);
  // Reader-facing: covers and book files (content lock applies).
  await app.register(serveRoutes, { db, booksDir: booksRoot, configDir: config.CONFIG_DIR });

  const service = new LibraryService({ db, booksDir: booksRoot, configDir: config.CONFIG_DIR, online: currentLookup, log: app.log });

  // Job runner hook (ws/requests): downloads and uploads scan as a job step. If a scan is
  // already running it may have missed the new files, so wait for it and scan once more.
  if (app.hasDecorator("jobs")) {
    app.jobs.register("library.scan", async () => {
      const wasRunning = service.getStatus().running;
      let report = await service.startScan();
      if (wasRunning) report = await service.startScan();
      return { added: report.added, removed: report.removed, errors: report.errors.length };
    });
  }

  // Scan at boot. onListen only fires for a real server (not app.inject in tests).
  if (config.LIBRARY_SCAN_ON_START) {
    app.addHook("onListen", async () => {
      if (!(await hasEntries(booksRoot))) {
        app.log.info({ booksDir: booksRoot }, "books folder is missing or empty; skipping startup scan");
        return;
      }
      service.startScan().catch(() => {
        // reported through getStatus().lastError and the log
      });
    });
  }

  /** Authors and files for a page of books, keyed by book id. */
  function details(ids: string[]) {
    if (!ids.length) return { authorsBy: new Map<string, string[]>(), filesBy: new Map<string, unknown[]>() };
    const authorRows = db
      .select({ bookId: bookAuthors.bookId, name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(inArray(bookAuthors.bookId, ids))
      .orderBy(asc(bookAuthors.position))
      .all();
    const fileRows = db
      .select({ bookId: bookFiles.bookId, id: bookFiles.id, relPath: bookFiles.relPath, format: bookFiles.format, sizeBytes: bookFiles.sizeBytes })
      .from(bookFiles)
      .where(inArray(bookFiles.bookId, ids))
      .all();
    const authorsBy = new Map<string, string[]>();
    for (const r of authorRows) authorsBy.set(r.bookId, [...(authorsBy.get(r.bookId) ?? []), r.name]);
    const filesBy = new Map<string, unknown[]>();
    for (const { bookId, ...f } of fileRows) filesBy.set(bookId, [...(filesBy.get(bookId) ?? []), f]);
    return { authorsBy, filesBy };
  }

  // --- Scanning ---------------------------------------------------------------

  app.get("/api/admin/library/scan", async (req) => {
    requireAdmin(req);
    return service.getStatus();
  });

  app.post("/api/admin/library/scan", async (req, reply) => {
    requireAdmin(req);
    service.startScan().catch(() => {
      // reported through getStatus().lastError
    });
    reply.code(202);
    return service.getStatus();
  });

  // --- Inbox ------------------------------------------------------------------

  app.get("/api/admin/inbox", async (req) => {
    requireAdmin(req);
    const q = parse(Page, req.query);
    const rows = db
      .select()
      .from(books)
      .where(eq(books.approved, false))
      .orderBy(desc(books.addedAt), asc(books.sortTitle))
      .limit(q.limit)
      .offset(q.offset)
      .all();
    const total = db.select({ n: sql<number>`count(*)` }).from(books).where(eq(books.approved, false)).get()?.n ?? 0;
    const { authorsBy, filesBy } = details(rows.map((r) => r.id));
    const items = rows.map((b) => ({
      id: b.id,
      title: b.title,
      subtitle: b.subtitle,
      authors: authorsBy.get(b.id) ?? [],
      publishedYear: b.publishedYear,
      isbn13: b.isbn13,
      coverPath: b.coverPath,
      description: b.description,
      rating: b.rating,
      ratingSource: b.ratingSource,
      files: filesBy.get(b.id) ?? [],
      addedAt: b.addedAt,
      possibleDuplicates: possibleDuplicates(b),
    }));
    return { items, total, limit: q.limit, offset: q.offset };
  });

  /** Other books that look like the same work (same ISBN, or same sort title). */
  function possibleDuplicates(b: typeof books.$inferSelect) {
    const conds = [eq(books.sortTitle, b.sortTitle)];
    if (b.isbn13) conds.push(eq(books.isbn13, b.isbn13));
    return db
      .select({ id: books.id, title: books.title, approved: books.approved })
      .from(books)
      .where(and(sql`${books.id} != ${b.id}`, sql`(${sql.join(conds, sql` or `)})`))
      .limit(10)
      .all();
  }

  function approve(ids: string[], rating: z.infer<typeof Rating> | undefined): number {
    const set: Partial<typeof books.$inferInsert> = { approved: true, updatedAt: Date.now() };
    if (rating) {
      set.rating = rating;
      set.ratingSource = "admin";
    }
    return db.update(books).set(set).where(inArray(books.id, ids)).run().changes;
  }

  app.post("/api/admin/inbox/approve", async (req) => {
    requireAdmin(req);
    const body = parse(ApproveBody, req.body);
    return { approved: approve(body.ids, body.rating) };
  });

  app.post("/api/admin/inbox/:id/approve", async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(ApproveOneBody, req.body ?? {});
    if (!approve([id], body.rating)) throw notFound();
    return db.select().from(books).where(eq(books.id, id)).get();
  });

  app.post("/api/admin/inbox/:id/reject", async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(RejectBody, req.body ?? {});
    const book = db.select().from(books).where(and(eq(books.id, id), eq(books.approved, false))).get();
    if (!book) throw notFound();
    const files = db.select().from(bookFiles).where(eq(bookFiles.bookId, id)).all();
    const moved: string[] = [];
    for (const f of files) {
      const abs = insideRoot(booksRoot, f.relPath);
      if (!abs) continue;
      if (body.deleteFiles) {
        await rm(abs, { force: true });
      } else {
        const target = insideRoot(booksRoot, join(".rejected", f.relPath));
        if (!target) continue;
        await mkdir(dirname(target), { recursive: true });
        await rename(abs, target).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err;
        });
        moved.push(relative(booksRoot, target).split(sep).join("/"));
      }
    }
    db.delete(books).where(eq(books.id, id)).run();
    return { rejected: id, deletedFiles: body.deleteFiles, movedTo: moved };
  });

  // --- Ratings and metadata ---------------------------------------------------

  app.put("/api/admin/books/:id/rating", async (req) => {
    requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const { rating } = parse(RatingBody, req.body);
    const changes = db
      .update(books)
      .set({ rating, ratingSource: rating ? "admin" : null, updatedAt: Date.now() })
      .where(eq(books.id, id))
      .run().changes;
    if (!changes) throw notFound();
    return db.select({ id: books.id, rating: books.rating, ratingSource: books.ratingSource }).from(books).where(eq(books.id, id)).get();
  });

  app.post("/api/admin/books/:id/metadata/refresh", async (req, reply) => {
    requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    if (!db.select({ id: books.id }).from(books).where(eq(books.id, id)).get()) throw notFound();
    const lookup = currentLookup();
    if (!lookup) {
      reply.code(409);
      return { error: "Online metadata lookup is turned off (Admin → Settings, or METADATA_ONLINE=false)" };
    }
    const result = await enrichBook({ db, configDir: config.CONFIG_DIR, bookId: id, lookup });
    return { ...result, book: db.select().from(books).where(eq(books.id, id)).get() };
  });

  // --- Duplicates -------------------------------------------------------------

  app.get("/api/admin/library/duplicates", async (req) => {
    requireAdmin(req);
    // Same bytes at more than one path.
    const sameFile = db
      .select({ sha256: bookFiles.sha256, paths: sql<string>`json_group_array(${bookFiles.relPath})`, bookIds: sql<string>`json_group_array(distinct ${bookFiles.bookId})` })
      .from(bookFiles)
      .where(isNotNull(bookFiles.sha256))
      .groupBy(bookFiles.sha256)
      .having(sql`count(*) > 1`)
      .all()
      .map((r) => ({ sha256: r.sha256, paths: JSON.parse(r.paths) as string[], bookIds: JSON.parse(r.bookIds) as string[] }));

    // Separate books that look like the same work.
    const byIsbn = db
      .select({ key: books.isbn13, ids: sql<string>`json_group_array(${books.id})` })
      .from(books)
      .where(isNotNull(books.isbn13))
      .groupBy(books.isbn13)
      .having(sql`count(*) > 1`)
      .all();
    const byTitle = db
      .select({ key: books.sortTitle, ids: sql<string>`json_group_array(${books.id})` })
      .from(books)
      .groupBy(books.sortTitle)
      .having(sql`count(*) > 1`)
      .all();
    const groups = new Map<string, { reason: "isbn" | "title"; key: string; bookIds: string[] }>();
    for (const r of byIsbn) {
      const ids = (JSON.parse(r.ids) as string[]).sort();
      groups.set(ids.join(","), { reason: "isbn", key: r.key!, bookIds: ids });
    }
    for (const r of byTitle) {
      const ids = (JSON.parse(r.ids) as string[]).sort();
      if (!groups.has(ids.join(","))) groups.set(ids.join(","), { reason: "title", key: r.key, bookIds: ids });
    }
    const allIds = [...new Set([...groups.values()].flatMap((g) => g.bookIds))];
    const titles = new Map(
      allIds.length
        ? db.select({ id: books.id, title: books.title, approved: books.approved }).from(books).where(inArray(books.id, allIds)).all().map((b) => [b.id, b])
        : [],
    );
    const { authorsBy } = details(allIds);
    const sameWork = [...groups.values()].map((g) => ({
      ...g,
      books: g.bookIds.map((id) => ({ ...titles.get(id), authors: authorsBy.get(id) ?? [] })),
    }));
    return { sameFile, sameWork };
  });
}

async function hasEntries(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).some((n) => !n.startsWith("."));
  } catch {
    return false;
  }
}
