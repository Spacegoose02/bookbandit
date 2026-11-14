/**
 * "Move in" imports (admin only): Calibre, Calibre-Web, Kavita, Goodreads/StoryGraph and
 * Google Play Books. Every import runs on the job runner, first as a dry run whose report
 * (matched, new, skipped, conflicts) the admin reads before running it for real.
 *
 * Endpoints (see README.md next to this file):
 *   POST /api/admin/imports/uploads        raw file body → { uploadId }
 *   GET  /api/admin/imports/people         people to map outside accounts to
 *   POST /api/admin/imports                { source, dryRun, ... } → { jobId }
 *   GET  /api/admin/imports[/:id]          import jobs with their reports
 *   GET  /api/reading-history/export.csv   your history as a Goodreads CSV (admins: ?userId=)
 *   GET  /api/books/:id/elsewhere          store links (Google Play) for a book you can see
 */
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { CONTENT_RATINGS } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { books, jobs, userIdentities, users } from "../db/schema.js";
import { httpError, requireAdmin, requireReader } from "../auth/plugin.js";
import { assertCanSee } from "../content/lock.js";
import type { SecretBox } from "../integrations/secrets.js";
import { PermanentJobError } from "../jobs/index.js";
import type { FetchLike } from "../metadata/providers/http.js";
import { parse } from "../requests/validate.js";
import { calibreIdMap, importCalibre, matchCalibreBooks, readCalibreLibrary } from "./calibre.js";
import { importCalibreWeb, readCalibreWeb } from "./calibre-web.js";
import { guessPerson, saveLink, Reporter, type ImportReport, type SourcePerson } from "./common.js";
import { exportGoodreadsCsv, importHistory, readHistoryCsv } from "./goodreads.js";
import { importGooglePlay, playBooksUrl, readPlayLibrary } from "./google-play.js";
import { fetchKavita, importKavita, kavitaBase } from "./kavita.js";
import { bookIdentifiers } from "./schema.js";

export const IMPORT_JOB = "import";

export interface ImportsOptions {
  db: Db;
  box: SecretBox;
  configDir: string;
  fetchImpl?: FetchLike;
}

const FileRef = z.union([
  z.object({ path: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ uploadId: z.string().uuid() }).strict(),
]);
type FileRef = z.infer<typeof FileRef>;

const People = z.record(z.string().max(40), z.string().uuid().nullable()).default({});

export const ImportRequest = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("calibre"),
    dryRun: z.boolean().default(true),
    metadataDb: FileRef,
    overwrite: z.enum(["calibre", "fill-gaps"]).default("calibre"),
    covers: z.boolean().default(true),
    approve: z.boolean().default(false),
  }),
  z.object({
    source: z.literal("calibre-web"),
    dryRun: z.boolean().default(true),
    appDb: FileRef,
    /** Optional when a Calibre import already ran: its links say which book is which. */
    metadataDb: FileRef.optional(),
    people: People,
    shelves: z.boolean().default(true),
  }),
  z.object({
    source: z.literal("kavita"),
    dryRun: z.boolean().default(true),
    url: z.string().trim().url().max(500),
    accounts: z
      .array(z.object({ apiKey: z.string().trim().min(8).max(200), userId: z.string().uuid().nullable() }))
      .min(1)
      .max(30),
    collections: z.boolean().default(true),
  }),
  z.object({
    source: z.literal("goodreads"),
    dryRun: z.boolean().default(true),
    file: z.object({ uploadId: z.string().uuid() }),
    userId: z.string().uuid(),
    markFinished: z.boolean().default(true),
    wantToRead: z.boolean().default(true),
    shelves: z.boolean().default(false),
  }),
  z.object({
    source: z.literal("google-play"),
    dryRun: z.boolean().default(true),
    file: z.object({ uploadId: z.string().uuid() }),
    rating: z.enum(CONTENT_RATINGS).optional(),
  }),
]);
export type ImportRequest = z.infer<typeof ImportRequest>;

const LABELS: Record<ImportRequest["source"], string> = {
  calibre: "Calibre library",
  "calibre-web": "Calibre-Web",
  kavita: "Kavita",
  goodreads: "Goodreads / StoryGraph",
  "google-play": "Google Play Books",
};

const UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const UPLOAD_TTL_MS = 7 * 24 * 3600_000;

export async function importsPlugin(app: FastifyInstance, opts: ImportsOptions) {
  const { db, box, configDir } = opts;
  const fetchFn = opts.fetchImpl ?? fetch;
  const uploadDir = resolve(configDir, "imports", "uploads");

  const uploadPath = (id: string) => join(uploadDir, id);
  const resolveFile = (ref: FileRef, expected: string, what: string): string => {
    if ("uploadId" in ref) {
      const p = uploadPath(ref.uploadId);
      if (!existsSync(p)) throw new PermanentJobError(`${what}: the uploaded file has expired; upload it again`);
      return p;
    }
    if (!isAbsolute(ref.path)) throw new PermanentJobError(`${what}: use the full path on the server, like /calibre/${expected}`);
    let p = resolve(ref.path);
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, expected);
    // Only the file we expect: this is not a way to read anything else on the server.
    if (basename(p) !== expected) throw new PermanentJobError(`${what}: the path must end in ${expected} (or be the folder that holds it)`);
    if (!existsSync(p)) throw new PermanentJobError(`${what}: no ${expected} at ${p}`);
    return p;
  };

  const householdPeople = (householdId: string) => {
    const list = db
      .select({ id: users.id, displayName: users.displayName, role: users.role })
      .from(users)
      .where(and(eq(users.householdId, householdId), eq(users.disabled, false)))
      .all();
    const ids = db.select({ userId: userIdentities.userId, subject: userIdentities.subject }).from(userIdentities).all();
    return list.map((p) => ({ ...p, emails: ids.filter((i) => i.userId === p.id).map((i) => i.subject.toLowerCase()) }));
  };

  // -------------------------------------------------------------------------
  // The job
  // -------------------------------------------------------------------------

  type Payload = ImportRequest & { by: string; householdId: string };

  app.jobs.register<Payload>(
    IMPORT_JOB,
    async (p, ctx) => {
      const report = new Reporter(p.source === "goodreads" ? "goodreads" : p.source, p.dryRun);
      const progress = (f: number) => ctx.progress(Math.max(0, Math.min(1, f)));
      const people = householdPeople(p.householdId);
      const inHousehold = (id: string | null | undefined) => (id && people.some((x) => x.id === id) ? id : null);
      try {
        switch (p.source) {
          case "calibre": {
            const file = resolveFile(p.metadataDb, "metadata.db", "Calibre library");
            const libraryDir = "path" in p.metadataDb ? resolve(file, "..") : null;
            const lib = readCalibreLibrary(file);
            ctx.log(`Read ${lib.books.length} books from Calibre`);
            const matches = await matchCalibreBooks(db, lib, libraryDir);
            progress(0.3);
            await importCalibre(db, lib, matches, { ...p, libraryDir, configDir }, report, (f) => progress(0.3 + f * 0.7));
            report.stat("books in Calibre", lib.books.length);
            break;
          }
          case "calibre-web": {
            const data = readCalibreWeb(resolveFile(p.appDb, "app.db", "Calibre-Web app.db"));
            let idMap: Map<number, string>;
            if (p.metadataDb) {
              const file = resolveFile(p.metadataDb, "metadata.db", "Calibre library");
              const lib = readCalibreLibrary(file);
              idMap = calibreIdMap(db, lib, await matchCalibreBooks(db, lib, "path" in p.metadataDb ? resolve(file, "..") : null));
              // Remember the matches, so the next Calibre-Web import doesn't need metadata.db.
              if (!p.dryRun) db.transaction((tx) => idMap.forEach((bookId, id) => saveLink(tx, "calibre", `${lib.uuid}:${id}`, bookId)));
            } else {
              idMap = calibreIdMap(db, null, null);
              if (!idMap.size) throw new PermanentJobError("Import the Calibre library first, or choose its metadata.db here too.");
            }
            const mapped: SourcePerson[] = data.users.map((u) => {
              const chosen = Object.prototype.hasOwnProperty.call(p.people, String(u.id));
              const userId = chosen ? inHousehold(p.people[String(u.id)]) : guessPerson(people, u);
              return { id: String(u.id), name: u.name, email: u.email, userId, guessed: !chosen && !!userId };
            });
            await importCalibreWeb(db, data, idMap, mapped, { ...p, dryRun: p.dryRun }, report);
            break;
          }
          case "kavita": {
            const keys = p.accounts.map((a) => ({ apiKey: box.open(a.apiKey), userId: inHousehold(a.userId) }));
            const accounts = await fetchKavita(fetchFn, p.url, keys, report, (f) => progress(f * 0.8));
            const mapped: SourcePerson[] = accounts.map((a) => ({ id: a.key, name: a.username, userId: a.userId, guessed: false }));
            await importKavita(db, accounts, mapped, { dryRun: p.dryRun, collections: p.collections }, report);
            if (!accounts.length) throw new PermanentJobError(report.report.warnings.join("; ") || "No Kavita account could sign in");
            break;
          }
          case "goodreads": {
            const userId = inHousehold(p.userId);
            if (!userId) throw new PermanentJobError("Choose whose reading history this is");
            const text = await readFile(resolveFile(p.file, "", "CSV"), "utf8");
            const { flavor, rows, errors } = readHistoryCsv(text);
            report.report.source = flavor;
            errors.slice(0, 50).forEach((e) => report.warn(e));
            if (!rows.length) throw new PermanentJobError(errors[0] ?? "No books in the file");
            await importHistory(db, flavor, rows, { ...p, userId }, report);
            break;
          }
          case "google-play": {
            const text = await readFile(resolveFile(p.file, "", "File"), "utf8");
            const { rows, errors } = readPlayLibrary(text);
            errors.slice(0, 50).forEach((e) => report.warn(e));
            if (!rows.length) throw new PermanentJobError(errors[0] ?? "No books in the file");
            await importGooglePlay(db, rows, { dryRun: p.dryRun, rating: p.rating }, report);
            break;
          }
        }
      } catch (e) {
        if (e instanceof PermanentJobError) throw e;
        // Bad files and refused API keys won't fix themselves on a retry.
        throw new PermanentJobError(e instanceof Error ? e.message : String(e));
      }
      const c = report.report.counts;
      ctx.log(`${p.dryRun ? "Dry run" : "Import"}: ${c.matched} matched, ${c.new} new, ${c.skipped} skipped, ${c.conflict} conflicts`);
      return report.report;
    },
    { maxAttempts: 1 },
  );

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  await app.register(async (scoped) => {
    // Raw uploads stream to disk; scoped so the rest of the API keeps its JSON-only parser.
    scoped.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

    scoped.post("/api/admin/imports/uploads", { bodyLimit: UPLOAD_MAX_BYTES }, async (req, reply) => {
      requireAdmin(req);
      const body = req.body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== "function") throw httpError(415, "Send the file as application/octet-stream");
      await mkdir(uploadDir, { recursive: true });
      await sweepUploads(uploadDir);
      const uploadId = crypto.randomUUID();
      const dest = uploadPath(uploadId);
      await pipeline(body, createWriteStream(dest));
      const size = (await stat(dest)).size;
      if (!size) {
        await rm(dest, { force: true });
        throw httpError(400, "The file is empty");
      }
      const name = typeof (req.query as { name?: unknown }).name === "string" ? String((req.query as { name: string }).name).slice(0, 200) : null;
      return reply.code(201).send({ uploadId, name, size });
    });
  });

  app.get("/api/admin/imports/people", async (req) => {
    const admin = requireAdmin(req);
    return { items: householdPeople(admin.householdId).map(({ emails: _e, ...p }) => p) };
  });

  app.post("/api/admin/imports", async (req, reply) => {
    const admin = requireAdmin(req);
    const body = parse(ImportRequest, req.body);
    if (body.source === "kavita") {
      try {
        kavitaBase(body.url);
      } catch (e) {
        throw httpError(400, e instanceof Error ? e.message : String(e));
      }
    }
    // Kavita API keys are sealed before they're stored in the jobs table.
    const payload =
      body.source === "kavita" ? { ...body, accounts: body.accounts.map((a) => ({ ...a, apiKey: box.seal(a.apiKey) })) } : body;
    const jobId = app.jobs.enqueue(
      IMPORT_JOB,
      { ...payload, by: admin.userId, householdId: admin.householdId },
      { label: `${body.dryRun ? "Dry run" : "Import"}: ${LABELS[body.source]}`, maxAttempts: 1 },
    );
    return reply.code(202).send({ jobId });
  });

  const view = (j: typeof jobs.$inferSelect) => {
    const p = j.payload as Partial<ImportRequest>;
    return {
      id: j.id,
      source: p.source ?? null,
      dryRun: p.dryRun ?? true,
      label: j.label,
      status: j.status,
      progress: j.progress,
      error: j.status === "failed" ? j.lastError : null,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      report: (j.result as ImportReport | null) ?? null,
    };
  };

  app.get("/api/admin/imports", async (req) => {
    requireAdmin(req);
    const rows = db.select().from(jobs).where(eq(jobs.type, IMPORT_JOB)).orderBy(desc(jobs.createdAt)).limit(30).all();
    return { items: rows.map((r) => ({ ...view(r), report: r.result ? summary(r.result as ImportReport) : null })) };
  });

  app.get("/api/admin/imports/:id", async (req) => {
    requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const row = db.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.type, IMPORT_JOB))).get();
    if (!row) throw httpError(404, "Not found");
    return view(row);
  });

  app.get("/api/reading-history/export.csv", async (req, reply) => {
    const reader = requireReader(req);
    const q = parse(z.object({ userId: z.string().uuid().optional() }), req.query);
    let userId = reader.userId;
    let name = "me";
    if (q.userId && q.userId !== reader.userId) {
      if (reader.role !== "admin") throw httpError(403, "Admins only");
      const who = db.select().from(users).where(and(eq(users.id, q.userId), eq(users.householdId, reader.householdId))).get();
      if (!who) throw httpError(404, "Not found");
      userId = who.id;
      name = who.displayName;
    }
    const csv = exportGoodreadsCsv(db, userId, reader);
    const safe = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "history";
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="bookbandit-goodreads-${safe}.csv"`)
      .send(csv);
  });

  app.get("/api/books/:id/elsewhere", async (req) => {
    const reader = requireReader(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    const book = db.select().from(books).where(eq(books.id, id)).get();
    if (!book) throw httpError(404, "Not found");
    assertCanSee(reader, book);
    const play = db
      .select({ value: bookIdentifiers.value })
      .from(bookIdentifiers)
      .where(and(eq(bookIdentifiers.bookId, id), eq(bookIdentifiers.type, "google-play")))
      .get()?.value;
    const volumeId = play && !play.startsWith("title:") ? play : null;
    return { googlePlay: volumeId ? { url: playBooksUrl(volumeId) } : play ? { url: null } : null };
  });

}

/** Counts only, for the list of past imports. */
function summary(r: ImportReport) {
  return { source: r.source, dryRun: r.dryRun, counts: r.counts, stats: r.stats, warnings: r.warnings.length };
}

async function sweepUploads(dir: string): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const p = join(dir, name);
    const s = await stat(p).catch(() => null);
    if (s && now - s.mtimeMs > UPLOAD_TTL_MS) await rm(p, { force: true }).catch(() => {});
  }
}
