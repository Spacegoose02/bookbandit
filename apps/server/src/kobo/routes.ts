/**
 * Kobo sync: the Kobo e-reader's store API, answered by Bookbandit, at /kobo/<token>/…
 * Set `api_endpoint=https://<your server>/kobo/<token>` in `.kobo/Kobo/Kobo eReader.conf`
 * (the token comes from /api/ereader/credentials) and the Kobo's Sync button pulls the library.
 *
 * - Library sync sends every book the person may see that has an EPUB or KEPUB, then only
 *   what changed. A book that gets re-rated out of reach (or deleted) is removed from the
 *   device on the next sync: the content lock applies to what's already on the e-reader too.
 * - Downloads are KEPUB, converted with kepubify and cached, or the EPUB when that's missing.
 * - Reading state goes both ways with reading_progress: the Kobo's position shows up in the
 *   web reader (at the right chapter and percentage), and the web reader's on the Kobo.
 * - Everything else the Kobo asks the store for gets an empty answer; nothing is proxied.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import type { Db } from "../db/client.js";
import { bookFiles, books, readingProgress } from "../db/schema.js";
import { TooManyAttemptsError } from "../auth/rate-limit.js";
import { ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import { enrich } from "../catalog/list.js";
import { CONTENT_TYPES, downloadName, insideRoot, sendFile } from "../library/serve.js";
import { isDrmProtected } from "../library/drm.js";
import { publicBaseUrl } from "../ereader/routes.js";
import type { CredentialStore, EreaderAuth } from "../ereader/credentials.js";
import { koboReadingStates, koboSyncedBooks } from "../ereader/schema.js";
import { absolutePath, filesByBook, loadVisibleBook, mirrorProgress, type BookRow, type FileRow } from "../ereader/library.js";
import { cfiForKoboSource, chapterCfi, koboSourceForCfi, readSpine } from "../ereader/epub-position.js";
import { koboResources } from "./resources.js";
import type { KepubConverter } from "./kepub.js";

/** Qualified, for correlated subqueries (drizzle leaves single-table columns unqualified). */
const BOOK_ID = sql.raw(`"books"."id"`);

/** Entitlements per sync reply; the Kobo asks again while `x-kobo-sync: continue` is set. */
export const SYNC_BATCH = 100;
const KOBO_FORMATS = ["kepub", "epub"] as const;
const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

const TokenParams = z.object({ token: z.string().min(1).max(200) });
const BookParams = TokenParams.extend({ id: z.string().min(1).max(64) });
const DownloadParams = BookParams.extend({ format: z.enum(KOBO_FORMATS) });

const Bookmark = z
  .object({
    LastModified: z.string().max(64).optional(),
    ProgressPercent: z.number().min(0).max(100).optional(),
    ContentSourceProgressPercent: z.number().min(0).max(100).optional(),
    Location: z
      .object({ Value: z.string().max(500).optional(), Type: z.string().max(64).optional(), Source: z.string().max(1000).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const StatusInfo = z
  .object({
    LastModified: z.string().max(64).optional(),
    Status: z.enum(["ReadyToRead", "Reading", "Finished"]).optional(),
    TimesStartedReading: z.number().int().min(0).optional(),
  })
  .passthrough();
const Statistics = z
  .object({
    LastModified: z.string().max(64).optional(),
    SpentReadingMinutes: z.number().min(0).optional(),
    RemainingTimeMinutes: z.number().min(0).optional(),
  })
  .passthrough();
const StateBody = z.object({
  ReadingStates: z
    .array(
      z
        .object({
          EntitlementId: z.string().max(64).optional(),
          CurrentBookmark: Bookmark.optional(),
          StatusInfo: StatusInfo.optional(),
          Statistics: Statistics.optional(),
        })
        .passthrough(),
    )
    .min(1)
    .max(50),
});

interface RawState {
  CurrentBookmark?: z.infer<typeof Bookmark>;
  StatusInfo?: z.infer<typeof StatusInfo>;
  Statistics?: z.infer<typeof Statistics>;
}

/** Kobo timestamps: ISO 8601 without milliseconds. */
export function koboTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface SyncToken {
  v: 1;
  /** reading_progress.server_updated_at already sent. */
  rs: number;
}

export function encodeSyncToken(t: SyncToken): string {
  return Buffer.from(JSON.stringify(t)).toString("base64");
}

export function decodeSyncToken(header: string | string[] | undefined): SyncToken | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  try {
    const t = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Partial<SyncToken>;
    return t.v === 1 && typeof t.rs === "number" && Number.isFinite(t.rs) ? { v: 1, rs: t.rs } : null;
  } catch {
    return null;
  }
}

class KoboAuthError extends Error {
  statusCode = 401;
}

export interface KoboOptions {
  db: Db;
  booksDir: string;
  configDir: string;
  credentials: CredentialStore;
  kepub: KepubConverter;
}

export async function koboRoutes(app: FastifyInstance, opts: KoboOptions) {
  const { db, credentials, kepub } = opts;
  const configRoot = resolve(opts.configDir);
  const authByRequest = new WeakMap<FastifyRequest, EreaderAuth>();

  // The Kobo sends JSON content types with empty bodies on some calls.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(Object.assign(err as Error, { statusCode: 400 }), undefined);
    }
  });

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof TooManyAttemptsError) {
      return reply.code(429).header("retry-after", Math.ceil(err.retryAfterMs / 1000)).send({ error: err.message });
    }
    if (err instanceof KoboAuthError) return reply.code(401).send({ error: "Unauthorized" });
    if (err instanceof ContentLockedError) return reply.code(404).send({ error: "Not found" });
    if (err instanceof ZodError) return reply.code(400).send({ error: "Bad request" });
    return reply.send(err);
  });

  app.addHook("preHandler", async (req) => {
    const parsed = TokenParams.safeParse(req.params);
    const auth = parsed.success ? credentials.verifyKoboToken(req, parsed.data.token) : null;
    if (!auth) throw new KoboAuthError("Unauthorized");
    authByRequest.set(req, auth);
  });

  const authOf = (req: FastifyRequest): EreaderAuth => authByRequest.get(req)!;
  const baseOf = (req: FastifyRequest) => `${publicBaseUrl(req)}/kobo/${TokenParams.parse(req.params).token}`;

  /** The file the Kobo should get for a book: a KEPUB if there is one, else the EPUB. */
  function koboFile(files: FileRow[]): FileRow | undefined {
    return files.find((f) => f.format === "kepub") ?? files.find((f) => f.format === "epub");
  }

  async function koboFormat(file: FileRow): Promise<"KEPUB" | "EPUB"> {
    return file.format === "kepub" || (await kepub.isAvailable()) ? "KEPUB" : "EPUB";
  }

  type Enriched = ReturnType<typeof enrich<BookRow>>[number];

  async function bookMetadata(base: string, b: Enriched, file: FileRow) {
    const format = await koboFormat(file);
    const s = b.series[0];
    return {
      Categories: ["00000000-0000-0000-0000-000000000001"],
      CoverImageId: b.coverPath ? `${b.id}` : undefined,
      CrossRevisionId: b.id,
      CurrentDisplayPrice: { CurrencyCode: "USD", TotalAmount: 0 },
      CurrentLoveDisplayPrice: { TotalAmount: 0 },
      Description: b.description ?? "",
      DownloadUrls: [
        {
          Format: format,
          Size: file.sizeBytes,
          Url: `${base}/download/${b.id}/${format === "KEPUB" ? "kepub" : "epub"}`,
          Platform: "Generic",
          DrmType: "None",
        },
      ],
      EntitlementId: b.id,
      ExternalIds: [],
      Genre: "00000000-0000-0000-0000-000000000001",
      IsEligibleForKoboLove: false,
      IsInternetArchive: false,
      IsPreOrder: false,
      IsSocialEnabled: true,
      Language: b.language ?? "en",
      PhoneticPronunciations: {},
      PublicationDate: b.publishedYear ? `${String(b.publishedYear).padStart(4, "0")}-01-01T00:00:00Z` : undefined,
      Publisher: { Imprint: "", Name: b.publisher ?? "" },
      RevisionId: b.id,
      Title: b.title,
      WorkId: b.id,
      ContributorRoles: b.authors.map((a) => ({ Name: a.name })),
      Contributors: b.authors.map((a) => a.name),
      ...(s
        ? {
            Series: {
              Name: s.name,
              Number: s.position ?? 1,
              NumberFloat: s.position ?? 1,
              Id: s.id,
            },
          }
        : {}),
    };
  }

  function bookEntitlement(b: BookRow, removed = false) {
    return {
      Accessibility: "Full",
      ActivePeriod: { From: koboTime(Date.now()) },
      Created: koboTime(b.addedAt),
      CrossRevisionId: b.id,
      Id: b.id,
      IsRemoved: removed,
      IsHiddenFromArchive: false,
      IsLocked: false,
      LastModified: koboTime(b.updatedAt ?? b.addedAt),
      OriginCategory: "Imported",
      RevisionId: b.id,
      Status: "Active",
    };
  }

  /** The Kobo's ReadingState for a book, from reading_progress and the Kobo's own last state. */
  async function readingState(userId: string, book: BookRow, file: FileRow | undefined) {
    const rp = db
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, userId), eq(readingProgress.bookId, book.id)))
      .get();
    const raw = db
      .select()
      .from(koboReadingStates)
      .where(and(eq(koboReadingStates.userId, userId), eq(koboReadingStates.bookId, book.id)))
      .get();
    const rawState = (raw?.state ?? {}) as RawState;
    const lastModified = Math.max(rp?.clientUpdatedAt ?? 0, raw?.updatedAt ?? 0) || book.addedAt;
    const lm = koboTime(lastModified);
    const percent = rp?.percent ?? (rawState.CurrentBookmark?.ProgressPercent ?? 0) / 100;
    const finished = rp?.finished ?? rawState.StatusInfo?.Status === "Finished";
    const status = finished ? "Finished" : percent > 0 ? "Reading" : "ReadyToRead";

    // The Kobo wrote last: hand back its own bookmark, which is more precise than ours.
    const koboIsNewest = raw && (!rp || raw.updatedAt >= rp.clientUpdatedAt);
    let location: { Value: string; Type: string; Source: string } | undefined;
    let contentSourcePercent: number | undefined;
    if (koboIsNewest && rawState.CurrentBookmark?.Location?.Source) {
      location = rawState.CurrentBookmark.Location as typeof location;
      contentSourcePercent = rawState.CurrentBookmark.ContentSourceProgressPercent;
    } else if (rp && file && (rp.locator as { kind: string }).kind === "epub") {
      const abs = absolutePath(opts.booksDir, file);
      const source = abs ? await koboSourceForCfi(abs, (rp.locator as { cfi: string }).cfi).catch(() => null) : null;
      if (source) location = { Value: "kobo.1.1", Type: "KoboSpan", Source: source };
    }

    return {
      EntitlementId: book.id,
      Created: koboTime(book.addedAt),
      LastModified: lm,
      PriorityTimestamp: lm,
      StatusInfo: {
        LastModified: lm,
        Status: status,
        TimesStartedReading: rawState.StatusInfo?.TimesStartedReading ?? (status === "ReadyToRead" ? 0 : 1),
      },
      Statistics: {
        LastModified: lm,
        ...(rawState.Statistics?.SpentReadingMinutes !== undefined ? { SpentReadingMinutes: rawState.Statistics.SpentReadingMinutes } : {}),
        ...(rawState.Statistics?.RemainingTimeMinutes !== undefined ? { RemainingTimeMinutes: rawState.Statistics.RemainingTimeMinutes } : {}),
      },
      CurrentBookmark: {
        LastModified: lm,
        ...(rp || raw ? { ProgressPercent: Math.round(percent * 10000) / 100 } : {}),
        ...(contentSourcePercent !== undefined ? { ContentSourceProgressPercent: contentSourcePercent } : {}),
        ...(location ? { Location: location } : {}),
      },
    };
  }

  /** Books this person may have on a Kobo: visible, not Kindle-only, with an EPUB or KEPUB. */
  const koboEligible = (auth: EreaderAuth) =>
    and(
      visibleBooksWhere(auth.reader),
      eq(books.kindleOnly, false),
      sql`exists (select 1 from ${bookFiles} where ${bookFiles.bookId} = ${BOOK_ID} and ${bookFiles.format} in ('epub', 'kepub'))`,
    );

  // -------------------------------------------------------------------------
  // Start-up and sign-in
  // -------------------------------------------------------------------------

  app.get("/kobo/:token/v1/initialization", async (req, reply) => {
    reply.header("x-kobo-apitoken", "e30=");
    return { Resources: koboResources(baseOf(req)) };
  });

  const deviceAuth = async (req: FastifyRequest) => {
    const body = (req.body ?? {}) as { UserKey?: unknown };
    return {
      AccessToken: `kobo-${crypto.randomUUID()}`,
      RefreshToken: `kobo-${crypto.randomUUID()}`,
      TokenType: "Bearer",
      TrackingId: crypto.randomUUID(),
      UserKey: typeof body.UserKey === "string" ? body.UserKey : authOf(req).credential.id,
    };
  };
  app.post("/kobo/:token/v1/auth/device", deviceAuth);
  app.post("/kobo/:token/v1/auth/refresh", deviceAuth);

  // -------------------------------------------------------------------------
  // Library sync
  // -------------------------------------------------------------------------

  app.get("/kobo/:token/v1/library/sync", async (req, reply) => {
    const auth = authOf(req);
    const credentialId = auth.credential.id;
    const base = baseOf(req);
    const previous = decodeSyncToken(req.headers["x-kobo-synctoken"]);
    const serverTime = Date.now() - 1;

    // No token we issued: the Kobo is new, reset or just switched over. Send everything.
    if (!previous) db.delete(koboSyncedBooks).where(eq(koboSyncedBooks.credentialId, credentialId)).run();

    const eligible = db
      .select({ id: books.id, changedAt: sql<number>`coalesce(${books.updatedAt}, ${books.addedAt})` })
      .from(books)
      .where(koboEligible(auth))
      .all();
    const eligibleIds = new Set(eligible.map((b) => b.id));
    const synced = new Map(
      db
        .select()
        .from(koboSyncedBooks)
        .where(eq(koboSyncedBooks.credentialId, credentialId))
        .all()
        .map((r) => [r.bookId, r]),
    );

    const results: unknown[] = [];

    // 1. Books no longer allowed (re-rated, unapproved, deleted, lost their file): remove them.
    const gone = [...synced.values()].filter((r) => !eligibleIds.has(r.bookId));
    for (const r of gone) {
      if (!r.archived) {
        const b = db.select().from(books).where(eq(books.id, r.bookId)).get();
        const stub = b ?? ({ id: r.bookId, addedAt: r.syncedAt, updatedAt: r.syncedAt } as BookRow);
        results.push({ ChangedEntitlement: { BookEntitlement: bookEntitlement(stub, true) } });
      }
      db.delete(koboSyncedBooks).where(and(eq(koboSyncedBooks.credentialId, credentialId), eq(koboSyncedBooks.bookId, r.bookId))).run();
    }

    // 2. New and changed books, oldest first, in batches.
    const toSend = eligible
      .filter((b) => {
        const s = synced.get(b.id);
        return !s || (!s.archived && b.changedAt > s.syncedAt);
      })
      .sort((a, b) => a.changedAt - b.changedAt);
    const batch = toSend.slice(0, SYNC_BATCH);
    const batchIds = batch.map((b) => b.id);
    const rows = batchIds.length ? db.select().from(books).where(inArray(books.id, batchIds)).all() : [];
    const enriched = new Map(enrich(db, auth.reader, rows).map((b) => [b.id, b]));
    const files = filesByBook(db, batchIds);
    for (const { id } of batch) {
      const b = enriched.get(id);
      const file = b ? koboFile(files.get(id) ?? []) : undefined;
      if (!b || !file) continue;
      const isNew = !synced.has(id);
      const entitlement = {
        BookEntitlement: bookEntitlement(b),
        BookMetadata: await bookMetadata(base, b, file),
        ...(isNew ? { ReadingState: await readingState(auth.reader.userId, b, file) } : {}),
      };
      results.push(isNew ? { NewEntitlement: entitlement } : { ChangedEntitlement: entitlement });
      db.insert(koboSyncedBooks)
        .values({ credentialId, bookId: id, syncedAt: serverTime })
        .onConflictDoUpdate({ target: [koboSyncedBooks.credentialId, koboSyncedBooks.bookId], set: { syncedAt: serverTime } })
        .run();
    }

    // 3. Reading positions that moved elsewhere (web reader, KOReader, tablets) since last time.
    if (previous) {
      const sentNow = new Set(batchIds);
      const moved = db
        .select({ bookId: readingProgress.bookId })
        .from(readingProgress)
        .innerJoin(books, eq(books.id, readingProgress.bookId))
        .where(and(eq(readingProgress.userId, auth.reader.userId), gt(readingProgress.serverUpdatedAt, previous.rs), koboEligible(auth)))
        .all()
        .map((r) => r.bookId)
        .filter((id) => !sentNow.has(id) && synced.has(id) && !synced.get(id)!.archived);
      if (moved.length) {
        const movedBooks = db.select().from(books).where(inArray(books.id, moved)).all();
        const movedFiles = filesByBook(db, moved);
        for (const b of movedBooks) {
          results.push({ ChangedReadingState: { ReadingState: await readingState(auth.reader.userId, b, koboFile(movedFiles.get(b.id) ?? [])) } });
        }
      }
    }

    reply.header("x-kobo-synctoken", encodeSyncToken({ v: 1, rs: serverTime }));
    if (toSend.length > SYNC_BATCH) reply.header("x-kobo-sync", "continue");
    return results;
  });

  app.get("/kobo/:token/v1/library/:id/metadata", async (req) => {
    const auth = authOf(req);
    const { id } = BookParams.parse(req.params);
    const book = loadVisibleBook(db, auth.reader, id);
    const file = koboFile(filesByBook(db, [id]).get(id) ?? []);
    if (!file || book.kindleOnly) throw new ContentLockedError();
    const [b] = enrich(db, auth.reader, [book]);
    return [await bookMetadata(baseOf(req), b!, file)];
  });

  /** "Remove from device" on the Kobo: don't send it again until it changes. */
  app.delete("/kobo/:token/v1/library/:id", async (req, reply) => {
    const auth = authOf(req);
    const { id } = BookParams.parse(req.params);
    loadVisibleBook(db, auth.reader, id);
    db.update(koboSyncedBooks)
      .set({ archived: true })
      .where(and(eq(koboSyncedBooks.credentialId, auth.credential.id), eq(koboSyncedBooks.bookId, id)))
      .run();
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // Reading state
  // -------------------------------------------------------------------------

  app.get("/kobo/:token/v1/library/:id/state", async (req) => {
    const auth = authOf(req);
    const { id } = BookParams.parse(req.params);
    const book = loadVisibleBook(db, auth.reader, id);
    return [await readingState(auth.reader.userId, book, koboFile(filesByBook(db, [id]).get(id) ?? []))];
  });

  app.put("/kobo/:token/v1/library/:id/state", async (req) => {
    const auth = authOf(req);
    const { id } = BookParams.parse(req.params);
    const book = loadVisibleBook(db, auth.reader, id);
    const body = StateBody.parse(req.body);
    const file = koboFile(filesByBook(db, [id]).get(id) ?? []);
    const abs = file ? absolutePath(opts.booksDir, file) : undefined;
    const now = Date.now();
    const userId = auth.reader.userId;

    for (const incoming of body.ReadingStates) {
      if (incoming.EntitlementId && incoming.EntitlementId !== id) continue;
      const existing = db
        .select()
        .from(koboReadingStates)
        .where(and(eq(koboReadingStates.userId, userId), eq(koboReadingStates.bookId, id)))
        .get();
      const merged: RawState = { ...((existing?.state ?? {}) as RawState) };
      if (incoming.CurrentBookmark) merged.CurrentBookmark = incoming.CurrentBookmark;
      if (incoming.StatusInfo) merged.StatusInfo = incoming.StatusInfo;
      if (incoming.Statistics) merged.Statistics = incoming.Statistics;
      // When the Kobo was at this state, by its clock (clamped): compared with reading_progress.
      const clientTime = Math.min(
        Date.parse(incoming.CurrentBookmark?.LastModified ?? incoming.StatusInfo?.LastModified ?? "") || now,
        now,
      );
      db.insert(koboReadingStates)
        .values({ userId, bookId: id, state: merged, updatedAt: clientTime })
        .onConflictDoUpdate({ target: [koboReadingStates.userId, koboReadingStates.bookId], set: { state: merged, updatedAt: clientTime } })
        .run();

      if (!incoming.CurrentBookmark && !incoming.StatusInfo) continue;
      const status = incoming.StatusInfo?.Status;
      const pctRaw = incoming.CurrentBookmark?.ProgressPercent ?? merged.CurrentBookmark?.ProgressPercent;
      const percent = status === "Finished" ? 1 : status === "ReadyToRead" ? 0 : (pctRaw ?? 0) / 100;

      let cfi: string | null = null;
      if (abs && file && percent > 0) {
        const source = merged.CurrentBookmark?.Location?.Source;
        cfi = source ? await cfiForKoboSource(abs, source).catch(() => null) : null;
        if (!cfi) {
          // No usable chapter: estimate it from the percentage so the web reader lands nearby.
          const spine = await readSpine(abs).catch(() => null);
          if (spine?.items.length) cfi = chapterCfi(spine, Math.min(spine.items.length - 1, Math.floor(percent * spine.items.length)));
        }
      }
      mirrorProgress(
        db,
        userId,
        book.id,
        {
          locator: { kind: "epub", cfi: cfi ?? "epubcfi(/6/2!/4)", percent },
          percent,
          finished: status === "Finished" ? true : status ? false : undefined,
          deviceName: `Kobo (${auth.credential.name})`,
        },
        clientTime,
        now,
      );
    }

    return {
      RequestResult: "Success",
      UpdateResults: [
        {
          EntitlementId: id,
          CurrentBookmarkResult: { Result: "Success" },
          StatisticsResult: { Result: "Success" },
          StatusInfoResult: { Result: "Success" },
        },
      ],
    };
  });

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  app.get("/kobo/:token/download/:id/:format", async (req, reply) => {
    const auth = authOf(req);
    const { id, format } = DownloadParams.parse(req.params);
    const book = loadVisibleBook(db, auth.reader, id);
    const files = filesByBook(db, [id]).get(id) ?? [];
    const kepubFile = files.find((f) => f.format === "kepub");
    const epubFile = files.find((f) => f.format === "epub");
    const file = format === "kepub" ? (kepubFile ?? epubFile) : (epubFile ?? kepubFile);
    const abs = file ? absolutePath(opts.booksDir, file) : undefined;
    const info = abs ? await stat(abs).catch(() => undefined) : undefined;
    if (!file || !abs || !info?.isFile()) throw new ContentLockedError();
    if (await isDrmProtected(abs, file.format)) {
      return reply.code(409).send({ error: "This file is DRM-protected and can't be sent to a Kobo." });
    }
    let path = abs;
    let size = info.size;
    let outFormat = file.format;
    if (format === "kepub" && file.format === "epub") {
      const converted = await kepub.convert(abs, { id: file.id, sizeBytes: info.size, mtimeMs: info.mtimeMs });
      const cinfo = converted ? await stat(converted).catch(() => undefined) : undefined;
      if (converted && cinfo) {
        path = converted;
        size = cinfo.size;
        outFormat = "kepub";
      }
    }
    return sendFile(reply, path, size, CONTENT_TYPES[outFormat], downloadName(book.title, outFormat), req.headers.range, "attachment");
  });

  async function cover(req: FastifyRequest, reply: FastifyReply) {
    const auth = authOf(req);
    const { imageId } = z.object({ imageId: z.string().min(1).max(64) }).parse(req.params);
    const book = loadVisibleBook(db, auth.reader, imageId);
    const abs = book.coverPath ? insideRoot(configRoot, book.coverPath) : undefined;
    const ext = book.coverPath?.split(".").pop()?.toLowerCase() ?? "";
    const info = abs ? await stat(abs).catch(() => undefined) : undefined;
    if (!abs || !info?.isFile() || !IMAGE_TYPES[ext]) throw new ContentLockedError();
    reply.header("cache-control", "private, max-age=86400");
    reply.header("content-length", info.size);
    reply.type(IMAGE_TYPES[ext]!);
    return reply.send(createReadStream(abs));
  }
  app.get("/kobo/:token/covers/:imageId/*", cover);

  // -------------------------------------------------------------------------
  // Store calls we don't serve: answer politely and empty
  // -------------------------------------------------------------------------

  app.get("/kobo/:token/v1/library/tags", async () => []);
  app.get("/kobo/:token/v1/user/profile", async () => ({}));
  app.get("/kobo/:token/v1/user/loyalty/benefits", async () => ({ Benefits: {} }));
  app.get("/kobo/:token/v1/deals", async () => ({}));
  app.post("/kobo/:token/v1/analytics/gettests", async (req) => ({
    Result: "Success",
    TestKey: ((req.body ?? {}) as { TestKey?: string }).TestKey ?? "",
    Tests: {},
  }));
  app.post("/kobo/:token/v1/analytics/event", async () => ({ Result: "Success" }));
  app.all("/kobo/:token/*", async () => ({}));
}
