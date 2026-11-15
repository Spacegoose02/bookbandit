/**
 * Librarian API (ws/librarian): duplicates, bulk edit, conversion, covers, library health.
 * Everything is admin-only (requireAdmin, CLAUDE.md rule 4). Like the inbox these are moderation
 * tools, so they list books whatever their rating or approval; reader-facing lists stay behind
 * visibleBooksWhere. Endpoint list: README.md in this folder.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, like, ne, or, sql, type SQL } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { CONTENT_RATINGS } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, bookFiles, books, bookSeries, bookTags, jobs, series, settings, tags } from "../db/schema.js";
import { httpError, requireAdmin } from "../auth/plugin.js";
import { useAuthErrors } from "../auth/errors.js";
import { lockFields, setBookAuthors } from "../library/store.js";
import type { BookLockField } from "@bookbandit/shared";
import { BOOK_FORMATS } from "../db/schema.js";
import type { LookupOptions } from "../metadata/lookup.js";
import { collapse } from "../metadata/text.js";
import { mergeBooks } from "../routes/admin-library.js";
import { describeBooks, loadBooks, setAside } from "./books.js";
import { groupKey, listDuplicates, SET_ASIDE_DIR } from "./duplicates.js";
import { duplicateIgnores } from "./schema.js";
import { CONVERT_JOB, KEPUB_JOB, needsConversionCount, pickSource, WRITE_METADATA_JOB, type ConvertPayload } from "./convert.js";
import { coverCandidates, coverFromFile, fetchCoverUrl, fileOfBook, imageMime, setBookCover } from "./covers.js";
import { currentProblems, HEALTH_CHECKS, HEALTH_JOB, healthCounts, healthWhere, lastFileReport } from "./health.js";

const Id = z.string().min(1).max(64);
const IdParams = z.object({ id: Id });
const Ids = z.array(Id).min(1).max(1000);
const SETTINGS_KEY = "librarian.settings";

const BooksQuery = z.object({
  q: z.string().trim().max(200).optional(),
  check: z.enum(HEALTH_CHECKS).optional(),
  format: z.enum(BOOK_FORMATS).optional(),
  seriesId: Id.optional(),
  sort: z.enum(["title", "added"]).default("title"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const name = z.string().trim().min(1).max(200).transform(collapse);

export const BulkBody = z
  .object({
    ids: Ids,
    /** null takes the books out of every series. */
    series: z
      .object({
        name,
        /** keep: positions stay as they are. sequence: number in the order of `ids`, from `start`. clear: no numbers. */
        numbering: z.enum(["keep", "sequence", "clear"]).default("keep"),
        start: z.number().min(0).max(100_000).default(1),
      })
      .nullable()
      .optional(),
    tagsAdd: z.array(name).max(50).optional(),
    tagsRemove: z.array(name).max(50).optional(),
    rating: z.enum(CONTENT_RATINGS).nullable().optional(),
    authors: z.array(name).min(1).max(20).optional(),
    language: z
      .string()
      .trim()
      .max(16)
      .transform((s) => (s === "" ? null : s.toLowerCase()))
      .nullable()
      .optional(),
  })
  .strict();

const KeepBody = z.object({ keepId: Id, otherIds: Ids }).strict();
const CopiesBody = z.object({ fileIds: Ids }).strict();
const IgnoreBody = z.object({ bookIds: z.array(Id).min(2).max(100) }).strict();
const ConvertBody = z.object({ bookIds: Ids, to: z.literal("epub").default("epub"), force: z.boolean().default(false) }).strict();
const KepubBody = z.object({ bookIds: z.array(Id).max(1000).optional() }).strict().default({});
const CoverBody = z.union([
  z.object({ url: z.string().url().max(2000) }).strict(),
  z.object({ fileId: Id }).strict(),
  z.object({ image: z.string().min(16).max(14_000_000) }).strict(),
]);
const SettingsBody = z.object({ writeMetadata: z.boolean() }).strict();

export interface LibrarianSettings {
  /** "Write metadata into the file" for EPUBs. Off by default: some people want files untouched. */
  writeMetadata: boolean;
}

export function librarianSettings(db: Db): LibrarianSettings {
  const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
  return { writeMetadata: false, ...(row?.value as Partial<LibrarianSettings> | undefined) };
}

export interface LibrarianRouteOptions {
  db: Db;
  booksRoot: string;
  configDir: string;
  resolveLookup: () => LookupOptions | false;
  fetchImpl: typeof fetch;
  tools: () => Promise<{ ebookConvert: boolean; kepubify: boolean }>;
}

export async function librarianRoutes(app: FastifyInstance, opts: LibrarianRouteOptions) {
  const { db, booksRoot } = opts;
  const configRoot = resolve(opts.configDir);
  useAuthErrors(app);

  const bookOr404 = (id: string) => {
    const [b] = describeBooks(db, loadBooks(db, [id]));
    if (!b) throw httpError(404, "Not found");
    return b;
  };

  // --- Book list for bulk edit and health ---------------------------------------

  app.get("/api/admin/librarian/books", async (req) => {
    requireAdmin(req);
    const q = BooksQuery.parse(req.query);
    const conds: (SQL | undefined)[] = [];
    if (q.q) {
      const pat = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      conds.push(
        or(
          sql`${books.title} like ${pat} escape '\\'`,
          sql`exists (select 1 from ${bookAuthors} join ${authors} on ${authors.id} = ${bookAuthors.authorId} where ${bookAuthors.bookId} = ${books.id} and ${authors.name} like ${pat} escape '\\')`,
          sql`exists (select 1 from ${bookSeries} join ${series} on ${series.id} = ${bookSeries.seriesId} where ${bookSeries.bookId} = ${books.id} and ${series.name} like ${pat} escape '\\')`,
        ),
      );
    }
    if (q.check) conds.push(healthWhere(q.check));
    if (q.format) conds.push(sql`exists (select 1 from ${bookFiles} where ${bookFiles.bookId} = ${books.id} and ${bookFiles.format} = ${q.format})`);
    if (q.seriesId) conds.push(sql`exists (select 1 from ${bookSeries} where ${bookSeries.bookId} = ${books.id} and ${bookSeries.seriesId} = ${q.seriesId})`);
    const where = and(...conds);
    const order = q.sort === "added" ? [desc(books.addedAt), asc(books.sortTitle)] : [asc(books.sortTitle), asc(books.id)];
    const rows = db.select().from(books).where(where).orderBy(...order).limit(q.limit).offset(q.offset).all();
    const total = db.select({ n: sql<number>`count(*)` }).from(books).where(where).get()?.n ?? 0;
    return { items: describeBooks(db, rows), total, limit: q.limit, offset: q.offset };
  });

  app.get("/api/admin/librarian/series", async (req) => {
    requireAdmin(req);
    return {
      series: db
        .select({ id: series.id, name: series.name, books: sql<number>`count(${bookSeries.bookId})` })
        .from(series)
        .leftJoin(bookSeries, eq(bookSeries.seriesId, series.id))
        .groupBy(series.id)
        .orderBy(asc(sql`lower(${series.name})`))
        .all(),
    };
  });

  // --- Bulk edit ----------------------------------------------------------------

  app.post("/api/admin/librarian/bulk", async (req) => {
    requireAdmin(req);
    const body = BulkBody.parse(req.body);
    const ids = [...new Set(body.ids)];
    const found = new Set(db.select({ id: books.id }).from(books).where(inArray(books.id, ids)).all().map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw httpError(404, `${missing.length} of those books no longer exist`);
    const now = Date.now();

    db.transaction((tx) => {
      const set: Partial<typeof books.$inferInsert> = { updatedAt: now };
      if (body.rating !== undefined) {
        set.rating = body.rating;
        set.ratingSource = body.rating ? "admin" : null;
      }
      if (body.language !== undefined) set.language = body.language;
      tx.update(books).set(set).where(inArray(books.id, ids)).run();

      if (body.authors) for (const id of ids) setBookAuthors(tx, id, body.authors);

      if (body.series === null) {
        tx.delete(bookSeries).where(inArray(bookSeries.bookId, ids)).run();
      } else if (body.series) {
        const s = body.series;
        let row = tx.select({ id: series.id }).from(series).where(sql`lower(${series.name}) = ${s.name.toLowerCase()}`).get();
        if (!row) [row] = tx.insert(series).values({ name: s.name, adminManaged: true }).returning({ id: series.id }).all();
        // An admin-managed series is never rewritten by a metadata refresh or rescan.
        tx.update(series).set({ adminManaged: true }).where(eq(series.id, row!.id)).run();
        const before = new Map(
          tx.select({ bookId: bookSeries.bookId, position: bookSeries.position }).from(bookSeries).where(inArray(bookSeries.bookId, ids)).all().map((r) => [r.bookId, r.position]),
        );
        tx.delete(bookSeries).where(inArray(bookSeries.bookId, ids)).run();
        ids.forEach((bookId, i) => {
          const position = s.numbering === "sequence" ? s.start + i : s.numbering === "clear" ? null : (before.get(bookId) ?? null);
          tx.insert(bookSeries).values({ bookId, seriesId: row!.id, position }).run();
        });
      }

      for (const tagName of body.tagsAdd ?? []) {
        // Reuse a tag of any kind with that name (a genre the scanner made, or a section); else a custom one.
        // Never a raw `subject` tag: those aren't listed as categories, so the tag would vanish.
        let tag = tx.select({ id: tags.id }).from(tags).where(and(sql`lower(${tags.name}) = ${tagName.toLowerCase()}`, ne(tags.kind, "subject"))).orderBy(sql`${tags.kind} = 'custom' desc`).get();
        if (!tag) [tag] = tx.insert(tags).values({ name: tagName, kind: "custom" }).returning({ id: tags.id }).all();
        for (const bookId of ids) tx.insert(bookTags).values({ bookId, tagId: tag!.id }).onConflictDoNothing().run();
      }
      if (body.tagsRemove?.length) {
        const tagIds = tx
          .select({ id: tags.id })
          .from(tags)
          .where(inArray(sql`lower(${tags.name})`, body.tagsRemove.map((t) => t.toLowerCase())))
          .all()
          .map((t) => t.id);
        if (tagIds.length) tx.delete(bookTags).where(and(inArray(bookTags.bookId, ids), inArray(bookTags.tagId, tagIds))).run();
      }

      // What an admin set by hand stays set: refreshes and the auto-categorizer leave it alone.
      const locks: BookLockField[] = [];
      if (body.rating !== undefined) locks.push("rating");
      if (body.language !== undefined) locks.push("language");
      if (body.authors) locks.push("authors");
      if (body.series !== undefined) locks.push("series");
      if (body.tagsAdd?.length || body.tagsRemove?.length) locks.push("categories");
      lockFields(tx, ids, locks);
    });

    let queued = 0;
    if (librarianSettings(db).writeMetadata && app.hasDecorator("jobs") && (body.series !== undefined || body.authors || body.language !== undefined)) {
      queued = enqueueWriteMetadata(ids);
    }
    return { updated: ids.length, writeMetadataJobs: queued, items: describeBooks(db, loadBooks(db, ids)) };
  });

  // --- Duplicates ---------------------------------------------------------------

  app.get("/api/admin/librarian/duplicates", async (req) => {
    requireAdmin(req);
    return listDuplicates(db);
  });

  /** Merge formats: every other book (files, progress, bookmarks, shelves) into the kept one. */
  app.post("/api/admin/librarian/duplicates/merge", async (req) => {
    requireAdmin(req);
    const { keepId, otherIds } = KeepBody.parse(req.body);
    const others = [...new Set(otherIds)].filter((id) => id !== keepId);
    if (!others.length) throw httpError(400, "Pick at least one other book");
    bookOr404(keepId);
    for (const id of others) bookOr404(id);
    for (const id of others) mergeBooks(db, id, keepId);
    return { kept: bookOr404(keepId), merged: others };
  });

  /**
   * Keep one: the other books' files are set aside in BOOKS_DIR/.duplicates (not deleted), and
   * their reading progress, bookmarks and shelves move to the kept book.
   */
  app.post("/api/admin/librarian/duplicates/keep", async (req) => {
    requireAdmin(req);
    const { keepId, otherIds } = KeepBody.parse(req.body);
    const others = [...new Set(otherIds)].filter((id) => id !== keepId);
    if (!others.length) throw httpError(400, "Pick at least one other book");
    bookOr404(keepId);
    for (const id of others) bookOr404(id);
    const setAsideTo: string[] = [];
    for (const id of others) {
      for (const f of db.select().from(bookFiles).where(eq(bookFiles.bookId, id)).all()) {
        const moved = await setAside(booksRoot, f.relPath, SET_ASIDE_DIR);
        if (moved) setAsideTo.push(moved);
        db.delete(bookFiles).where(eq(bookFiles.id, f.id)).run();
      }
      mergeBooks(db, id, keepId);
    }
    return { kept: bookOr404(keepId), removed: others, setAside: setAsideTo };
  });

  /** Same bytes at several paths: set the chosen extra copies aside. The last copy always stays. */
  app.post("/api/admin/librarian/duplicates/copies", async (req) => {
    requireAdmin(req);
    const { fileIds } = CopiesBody.parse(req.body);
    const files = db.select().from(bookFiles).where(inArray(bookFiles.id, fileIds)).all();
    if (files.length !== new Set(fileIds).size) throw httpError(404, "Some of those files are no longer in the library");
    for (const f of files) {
      if (!f.sha256) throw httpError(400, `${f.relPath} has no hash yet; rescan first`);
      const all = db.select({ id: bookFiles.id }).from(bookFiles).where(eq(bookFiles.sha256, f.sha256)).all();
      if (all.every((x) => fileIds.includes(x.id))) throw httpError(400, `Keep at least one copy of ${f.relPath}`);
    }
    const setAsideTo: string[] = [];
    for (const f of files) {
      const moved = await setAside(booksRoot, f.relPath, SET_ASIDE_DIR);
      if (moved) setAsideTo.push(moved);
      db.delete(bookFiles).where(eq(bookFiles.id, f.id)).run();
    }
    return { removed: files.length, setAside: setAsideTo };
  });

  app.post("/api/admin/librarian/duplicates/ignore", async (req) => {
    const reader = requireAdmin(req);
    const { bookIds } = IgnoreBody.parse(req.body);
    db.insert(duplicateIgnores).values({ groupKey: groupKey([...new Set(bookIds)]), ignoredBy: reader.userId }).onConflictDoNothing().run();
    return { ignored: true };
  });

  app.delete("/api/admin/librarian/duplicates/ignore", async (req) => {
    requireAdmin(req);
    return { cleared: db.delete(duplicateIgnores).run().changes };
  });

  // --- Conversion ----------------------------------------------------------------

  function enqueueWriteMetadata(ids: string[]): number {
    let n = 0;
    for (const b of describeBooks(db, loadBooks(db, ids))) {
      if (!b.files.some((f) => f.format === "epub" || f.format === "kepub")) continue;
      app.jobs.enqueue(WRITE_METADATA_JOB, { bookId: b.id }, { label: `Write details into ${b.title}` });
      n++;
    }
    return n;
  }

  app.get("/api/admin/librarian/tools", async (req) => {
    requireAdmin(req);
    const recent = db
      .select({ id: jobs.id, type: jobs.type, label: jobs.label, status: jobs.status, progress: jobs.progress, lastError: jobs.lastError, result: jobs.result, createdAt: jobs.createdAt, finishedAt: jobs.finishedAt })
      .from(jobs)
      .where(like(jobs.type, "librarian.%"))
      .orderBy(desc(jobs.createdAt))
      .limit(30)
      .all();
    return {
      ...(await opts.tools()),
      needsConversion: needsConversionCount(db),
      epubBooks: db.select({ n: sql<number>`count(distinct ${bookFiles.bookId})` }).from(bookFiles).where(eq(bookFiles.format, "epub")).get()?.n ?? 0,
      settings: librarianSettings(db),
      jobs: recent,
    };
  });

  app.get("/api/admin/librarian/convertible", async (req) => {
    requireAdmin(req);
    const rows = db
      .select()
      .from(books)
      .where(
        sql`exists (select 1 from ${bookFiles} where ${bookFiles.bookId} = ${books.id} and ${bookFiles.format} in ('azw3', 'mobi', 'fb2', 'txt'))
          and not exists (select 1 from ${bookFiles} where ${bookFiles.bookId} = ${books.id} and ${bookFiles.format} in ('epub', 'kepub'))`,
      )
      .orderBy(asc(books.sortTitle))
      .limit(500)
      .all();
    return { items: describeBooks(db, rows) };
  });

  app.post("/api/admin/librarian/convert", async (req, reply) => {
    requireAdmin(req);
    const body = ConvertBody.parse(req.body);
    const tools = await opts.tools();
    if (!tools.ebookConvert) throw httpError(409, "Calibre's ebook-convert isn't installed here (it is in the Docker image; set EBOOK_CONVERT_PATH otherwise)");
    const queued: { bookId: string; jobId: string }[] = [];
    const skipped: { bookId: string; reason: string }[] = [];
    for (const b of describeBooks(db, loadBooks(db, [...new Set(body.bookIds)]))) {
      const src = pickSource(b.files, body.force);
      if (src === "has_epub") skipped.push({ bookId: b.id, reason: "Already has an EPUB" });
      else if (src === "nothing") skipped.push({ bookId: b.id, reason: "No MOBI, AZW3, FB2 or TXT file to convert" });
      else {
        const payload: ConvertPayload = { bookId: b.id, fileId: src.id, to: "epub" };
        queued.push({ bookId: b.id, jobId: app.jobs.enqueue(CONVERT_JOB, payload, { label: `Convert ${b.title} (${src.format.toUpperCase()} → EPUB)` }) });
      }
    }
    reply.code(queued.length ? 202 : 200);
    return { queued, skipped };
  });

  app.post("/api/admin/librarian/kepub", async (req, reply) => {
    requireAdmin(req);
    const body = KepubBody.parse(req.body ?? {});
    if (!(await opts.tools()).kepubify) throw httpError(409, "kepubify isn't installed here (it is in the Docker image; set KEPUBIFY_PATH otherwise)");
    const jobId = app.jobs.enqueue(KEPUB_JOB, body.bookIds?.length ? { bookIds: body.bookIds } : {}, {
      label: body.bookIds?.length ? `Prepare ${body.bookIds.length} book${body.bookIds.length === 1 ? "" : "s"} for Kobo` : "Prepare every EPUB for Kobo",
    });
    reply.code(202);
    return { jobId };
  });

  app.get("/api/admin/librarian/settings", async (req) => {
    requireAdmin(req);
    return librarianSettings(db);
  });

  app.put("/api/admin/librarian/settings", async (req) => {
    requireAdmin(req);
    const body = SettingsBody.parse(req.body);
    const value = { ...librarianSettings(db), ...body };
    db.insert(settings)
      .values({ key: SETTINGS_KEY, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
      .run();
    return value;
  });

  app.post("/api/admin/librarian/write-metadata", async (req, reply) => {
    requireAdmin(req);
    const { bookIds } = z.object({ bookIds: Ids }).strict().parse(req.body);
    if (!librarianSettings(db).writeMetadata) throw httpError(409, "Writing details into files is off. Turn it on in Librarian → Convert first.");
    reply.code(202);
    return { queued: enqueueWriteMetadata([...new Set(bookIds)]) };
  });

  // --- Covers ----------------------------------------------------------------------

  app.get("/api/admin/librarian/books/:id/covers", async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const book = bookOr404(id);
    const { candidates, errors } = await coverCandidates(book, withFetch(opts.resolveLookup()));
    return { current: book.coverPath ? `/api/books/${encodeURIComponent(id)}/cover` : null, candidates, errors };
  });

  app.get("/api/admin/librarian/books/:id/covers/file/:fileId", async (req, reply) => {
    requireAdmin(req);
    const { id, fileId } = z.object({ id: Id, fileId: Id }).parse(req.params);
    const file = fileOfBook(db, id, fileId);
    if (!file) throw httpError(404, "Not found");
    const cover = await coverFromFile(booksRoot, file).catch(() => undefined);
    if (!cover) throw httpError(404, "No cover inside that file");
    reply.header("cache-control", "private, no-store");
    reply.type(cover.mime);
    return reply.send(cover.data);
  });

  app.get("/api/admin/librarian/books/:id/cover", async (req, reply) => {
    // Admin view of the current cover, for books a reader-facing route would hide (inbox, locked).
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const b = db.select({ coverPath: books.coverPath }).from(books).where(eq(books.id, id)).get();
    const abs = b?.coverPath ? resolve(configRoot, b.coverPath) : undefined;
    if (!abs || !abs.startsWith(configRoot) || !(await stat(abs).then((s) => s.isFile(), () => false))) throw httpError(404, "Not found");
    reply.header("cache-control", "private, no-store");
    const ext = abs.split(".").pop()!.toLowerCase();
    reply.type({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" }[ext] ?? "application/octet-stream");
    return reply.send(createReadStream(abs));
  });

  app.post("/api/admin/librarian/books/:id/cover", { bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const body = CoverBody.parse(req.body);
    const book = bookOr404(id);
    let cover;
    if ("url" in body) {
      cover = await fetchCoverUrl(opts.fetchImpl, body.url).catch(() => undefined);
      if (!cover) throw httpError(422, "Couldn't download an image from that address");
    } else if ("fileId" in body) {
      const file = fileOfBook(db, id, body.fileId);
      if (!file) throw httpError(404, "Not found");
      cover = await coverFromFile(booksRoot, file).catch(() => undefined);
      if (!cover) throw httpError(422, "No cover inside that file");
    } else {
      const data = Buffer.from(body.image.replace(/^data:[^,]*,/, ""), "base64");
      const mime = imageMime(data);
      if (!mime) throw httpError(422, "That isn't a JPEG, PNG, WebP or GIF image");
      cover = { data, mime };
    }
    const rel = await setBookCover(db, configRoot, book.id, cover);
    if (!rel) throw httpError(422, "That image is too big or not a supported type");
    lockFields(db, [book.id], ["cover"]);
    return { book: bookOr404(id) };
  });

  // --- Health --------------------------------------------------------------------

  app.get("/api/admin/librarian/health", async (req) => {
    requireAdmin(req);
    const report = lastFileReport(db);
    const running = db
      .select({ id: jobs.id, status: jobs.status, progress: jobs.progress })
      .from(jobs)
      .where(and(eq(jobs.type, HEALTH_JOB), inArray(jobs.status, ["queued", "running"])))
      .get();
    return {
      counts: healthCounts(db),
      files: report ? { checkedAt: report.checkedAt, filesChecked: report.filesChecked, problems: currentProblems(db, report) } : null,
      running: running ?? null,
    };
  });

  app.post("/api/admin/librarian/health/check", async (req, reply) => {
    requireAdmin(req);
    const running = db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.type, HEALTH_JOB), inArray(jobs.status, ["queued", "running"]))).get();
    reply.code(202);
    return { jobId: running?.id ?? app.jobs.enqueue(HEALTH_JOB, {}, { label: "Check every book file" }) };
  });

  function withFetch(l: LookupOptions | false): LookupOptions | false {
    return l === false ? false : { fetch: opts.fetchImpl, ...l };
  }
}
