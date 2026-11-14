/**
 * KOReader progress sync, compatible with the kosync protocol, at /kosync.
 * In KOReader: Tools → Progress sync → Custom sync server → `https://<your server>/kosync`,
 * then Login with an e-reader username and password from Bookbandit (registration is off).
 *
 * Every update is stored as KOReader sent it (so books that aren't in the library still sync
 * between KOReader devices, like any kosync server). When the document is a library book the
 * person may see, the position is also written to reading_progress, translated to a CFI, so
 * the web reader and the tablets pick it up; and when the web reader is further along (newer),
 * KOReader gets that position back, translated to an XPointer.
 *
 * Content lock: a locked book is treated exactly like a file that isn't in the library. Its
 * reading_progress is never read or written, and the reply is the same as for an unknown file.
 */
import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import type { Db } from "../db/client.js";
import { TooManyAttemptsError } from "../auth/rate-limit.js";
import type { CredentialStore, EreaderAuth } from "../ereader/credentials.js";
import { koreaderProgress } from "../ereader/schema.js";
import { absolutePath, currentProgress, mirrorProgress, visibleFiles, type BookRow, type FileRow } from "../ereader/library.js";
import { cfiToXpointer, parseCfi, xpointerToCfi } from "../ereader/epub-position.js";
import { DigestIndex } from "./digest.js";

const PAGED = new Set(["pdf", "cbz", "cbr"]);
const REFLOW = new Set(["epub", "kepub"]);

const ProgressBody = z.object({
  document: z.string().trim().min(1).max(128),
  progress: z.union([z.string(), z.number()]).transform(String).pipe(z.string().max(4000)),
  percentage: z.coerce.number().min(0).max(1),
  device: z.string().max(100).default("KOReader"),
  device_id: z.string().max(100).default(""),
});
const DocParams = z.object({ document: z.string().trim().min(1).max(128) });

class KosyncError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface KosyncOptions {
  db: Db;
  booksDir: string;
  credentials: CredentialStore;
  digests?: DigestIndex;
}

export async function koreaderRoutes(app: FastifyInstance, opts: KosyncOptions) {
  const { db, credentials } = opts;
  const digests = opts.digests ?? new DigestIndex(db, opts.booksDir);

  app.addContentTypeParser(/^application\/vnd\.koreader\.v1\+json/, { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(Object.assign(err as Error, { statusCode: 400 }), undefined);
    }
  });

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof TooManyAttemptsError) {
      return reply.code(429).header("retry-after", Math.ceil(err.retryAfterMs / 1000)).send({ message: err.message });
    }
    if (err instanceof ZodError) return reply.code(400).send({ code: 2003, message: "Invalid request" });
    if (err instanceof KosyncError) return reply.code(err.statusCode).send({ code: 2001, message: err.message });
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ message: status >= 500 ? "Server error" : err.message });
  });

  function authOf(req: FastifyRequest): EreaderAuth {
    const user = req.headers["x-auth-user"];
    const key = req.headers["x-auth-key"];
    if (typeof user !== "string" || typeof key !== "string" || !user || !key) throw new KosyncError(401, "Unauthorized");
    const auth = credentials.verifyLogin(req, user, { md5Key: key });
    if (!auth) throw new KosyncError(401, "Unauthorized");
    return auth;
  }

  /** The library file for a KOReader document, if the person may see its book. */
  async function libraryMatch(auth: EreaderAuth, document: string): Promise<{ file: FileRow; book: BookRow; abs: string } | null> {
    const ids = await digests.find(document);
    for (const { file, book } of visibleFiles(db, auth.reader, ids)) {
      const abs = absolutePath(opts.booksDir, file);
      if (abs) return { file, book, abs };
    }
    return null;
  }

  app.post("/kosync/users/create", async (_req, reply) => {
    return reply.code(402).send({
      code: 2005,
      message: "Sign-ups are off. Create an e-reader login in Bookbandit, then use Login here.",
    });
  });

  app.get("/kosync/users/auth", async (req) => {
    authOf(req);
    return { authorized: "OK" };
  });

  app.get("/kosync/healthcheck", async () => ({ state: "OK" }));

  app.put("/kosync/syncs/progress", async (req) => {
    const auth = authOf(req);
    const body = ProgressBody.parse(req.body);
    const document = body.document.toLowerCase();
    const now = Date.now();
    const values = {
      progress: body.progress,
      percentage: body.percentage,
      device: body.device || "KOReader",
      deviceId: body.device_id,
      updatedAt: now,
    };
    db.insert(koreaderProgress)
      .values({ userId: auth.reader.userId, document, ...values })
      .onConflictDoUpdate({ target: [koreaderProgress.userId, koreaderProgress.document], set: values })
      .run();

    const match = await libraryMatch(auth, document);
    if (match) {
      const deviceName = `KOReader (${values.device})`;
      if (REFLOW.has(match.file.format)) {
        const cfi = await xpointerToCfi(match.abs, body.progress).catch(() => null);
        if (cfi) {
          mirrorProgress(db, auth.reader.userId, match.book.id, { locator: { kind: "epub", cfi, percent: body.percentage }, percent: body.percentage, deviceName }, now, now);
        }
      } else if (PAGED.has(match.file.format)) {
        // KOReader counts pages from 1; the web reader's page locator counts from 0.
        const page = Number.parseInt(body.progress, 10);
        if (Number.isFinite(page) && page >= 1) {
          const totalPages = body.percentage > 0 ? Math.max(page, Math.round(page / body.percentage)) : 0;
          mirrorProgress(db, auth.reader.userId, match.book.id, { locator: { kind: "page", page: page - 1, totalPages }, percent: body.percentage, deviceName }, now, now);
        }
      }
    }
    return { document, timestamp: Math.floor(now / 1000) };
  });

  app.get("/kosync/syncs/progress/:document", async (req) => {
    const auth = authOf(req);
    const document = DocParams.parse(req.params).document.toLowerCase();
    const own = db
      .select()
      .from(koreaderProgress)
      .where(and(eq(koreaderProgress.userId, auth.reader.userId), eq(koreaderProgress.document, document)))
      .get();

    const match = await libraryMatch(auth, document);
    const shared = match ? currentProgress(db, auth.reader.userId, match.book.id) : undefined;
    // The web reader or another device moved on since KOReader last wrote: send that position.
    if (match && shared && (!own || shared.clientUpdatedAt > own.updatedAt)) {
      const progress = await toKoreaderProgress(match.file, match.abs, shared.locator as never);
      if (progress) {
        return {
          document,
          progress,
          percentage: shared.percent,
          device: shared.deviceName ?? "Bookbandit",
          device_id: "bookbandit",
          timestamp: Math.floor(shared.clientUpdatedAt / 1000),
        };
      }
    }
    if (!own) return {};
    return {
      document,
      progress: own.progress,
      percentage: own.percentage,
      device: own.device,
      device_id: own.deviceId,
      timestamp: Math.floor(own.updatedAt / 1000),
    };
  });
}

type Locator = { kind: "epub"; cfi: string; percent: number } | { kind: "page"; page: number; totalPages: number } | { kind: "audio" };

async function toKoreaderProgress(file: FileRow, abs: string, locator: Locator): Promise<string | null> {
  if (REFLOW.has(file.format)) {
    return locator.kind === "epub" ? cfiToXpointer(abs, locator.cfi).catch(() => null) : null;
  }
  if (PAGED.has(file.format)) {
    if (locator.kind === "page") return String(Math.max(0, locator.page) + 1);
    // Comics open in foliate, one section per page.
    if (locator.kind === "epub") {
      const parsed = parseCfi(locator.cfi);
      return parsed ? String(parsed.spineIndex + 1) : null;
    }
  }
  return null;
}
