/**
 * Reading progress sync (per profile, across devices).
 *
 * Conflict rule: newest position wins, judged by the client's own clock (when the reader
 * actually turned the page), not by when the update reached the server. A tablet that was
 * offline can upload later without overwriting a newer position from the web reader.
 * Client times in the future are clamped to the server's clock so one bad clock can't
 * pin a position forever.
 *
 * Every route goes through the content lock: a locked book returns 404, and lists only
 * include books the reader may see right now (a re-rated book drops out at once).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { locatorPercent, type ProgressRecord, type ReadingLocator } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { books, readingProgress } from "../db/schema.js";
import { requireReader } from "../auth/plugin.js";
import type { Reader } from "../auth/reader.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../content/lock.js";

// ---------------------------------------------------------------------------
// Shared helpers for the sync routes (progress, bookmarks, shelves)
// ---------------------------------------------------------------------------

export const LocatorSchema: z.ZodType<ReadingLocator> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("epub"), cfi: z.string().min(1).max(2000), percent: z.number().min(0).max(1) }),
  z.object({ kind: z.literal("page"), page: z.number().int().min(0), totalPages: z.number().int().min(0) }),
  z.object({
    kind: z.literal("audio"),
    seconds: z.number().min(0),
    durationSeconds: z.number().min(0),
  }),
]);

/** ISO 8601 string or ms since epoch → ms. */
export const ClientTime = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .datetime({ offset: true })
    .transform((s) => Date.parse(s)),
]);

export const SinceQuery = z.object({ since: z.coerce.number().int().nonnegative().optional() });

/** Parse with zod; on failure reply 400 and return null. */
export function parseOr400<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  reply: FastifyReply,
): z.infer<T> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  void reply.code(400).send({ error: "Invalid request", issues: result.error.issues });
  return null;
}

/** Load a book the reader may see, or throw a 404 (missing and locked look the same). */
export function loadVisibleBook(db: Db, reader: Reader, bookId: string) {
  const book = db
    .select({ id: books.id, rating: books.rating, approved: books.approved })
    .from(books)
    .where(eq(books.id, bookId))
    .get();
  if (!book) throw new ContentLockedError();
  assertCanSee(reader, book);
  return book;
}

export function toProgressRecord(row: typeof readingProgress.$inferSelect): ProgressRecord {
  return {
    bookId: row.bookId,
    locator: row.locator as ReadingLocator,
    percent: row.percent,
    finished: row.finished,
    deviceName: row.deviceName,
    clientUpdatedAt: row.clientUpdatedAt,
    serverUpdatedAt: row.serverUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const ProgressBody = z.object({
  locator: LocatorSchema,
  /** When the reader was at this position, by the device's clock. */
  updatedAt: ClientTime,
  deviceName: z.string().trim().min(1).max(80),
  /** 0 to 1. Defaults to what the locator implies. */
  percent: z.number().min(0).max(1).optional(),
  finished: z.boolean().optional(),
});

const BatchBody = z.object({
  updates: z.array(ProgressBody.extend({ bookId: z.string().min(1).max(64) })).min(1).max(500),
});

type ApplyResult =
  | { bookId: string; status: "applied" | "stale"; progress: ProgressRecord }
  | { bookId: string; status: "not_found" };

export async function progressRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  /** Apply one update with newest-wins. Assumes the book is visible to the reader. */
  function apply(reader: Reader, bookId: string, body: z.infer<typeof ProgressBody>, now: number): ApplyResult {
    const clientUpdatedAt = Math.min(body.updatedAt, now);
    const current = db
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, reader.userId), eq(readingProgress.bookId, bookId)))
      .get();
    if (current && current.clientUpdatedAt >= clientUpdatedAt) {
      return { bookId, status: "stale", progress: toProgressRecord(current) };
    }
    const percent = body.percent ?? locatorPercent(body.locator);
    const values = {
      locator: body.locator,
      percent,
      finished: body.finished ?? percent >= 0.99,
      deviceName: body.deviceName,
      clientUpdatedAt,
      serverUpdatedAt: now,
    };
    const [row] = db
      .insert(readingProgress)
      .values({ userId: reader.userId, bookId, ...values })
      .onConflictDoUpdate({ target: [readingProgress.userId, readingProgress.bookId], set: values })
      .returning()
      .all();
    return { bookId, status: "applied", progress: toProgressRecord(row!) };
  }

  /**
   * All of the reader's positions changed after `since` (server ms), for books they can see.
   * Clients keep `serverTime` from the reply and pass it as `since` next time.
   */
  app.get("/api/progress", async (req, reply) => {
    const reader = requireReader(req);
    const q = parseOr400(SinceQuery, req.query, reply);
    if (!q) return reply;
    // One ms behind so a write landing in this same ms is sent again next time, never missed.
    const serverTime = Date.now() - 1;
    const rows = db
      .select({ progress: readingProgress })
      .from(readingProgress)
      .innerJoin(books, eq(books.id, readingProgress.bookId))
      .where(
        and(
          eq(readingProgress.userId, reader.userId),
          visibleBooksWhere(reader),
          q.since === undefined ? undefined : gt(readingProgress.serverUpdatedAt, q.since),
        ),
      )
      .orderBy(desc(readingProgress.serverUpdatedAt))
      .all();
    return { items: rows.map((r) => toProgressRecord(r.progress)), serverTime };
  });

  app.get<{ Params: { bookId: string } }>("/api/progress/:bookId", async (req) => {
    const reader = requireReader(req);
    loadVisibleBook(db, reader, req.params.bookId);
    const row = db
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, reader.userId), eq(readingProgress.bookId, req.params.bookId)))
      .get();
    return { progress: row ? toProgressRecord(row) : null };
  });

  /** Save a position. Replies with the winning position, which may be newer than the one sent. */
  app.put<{ Params: { bookId: string } }>("/api/progress/:bookId", async (req, reply) => {
    const reader = requireReader(req);
    loadVisibleBook(db, reader, req.params.bookId);
    const body = parseOr400(ProgressBody, req.body, reply);
    if (!body) return reply;
    return apply(reader, req.params.bookId, body, Date.now());
  });

  /**
   * Upload positions saved while offline. Each update is judged on its own; books the
   * reader can't see come back as "not_found", the same as books that don't exist.
   */
  app.post("/api/progress/batch", async (req, reply) => {
    const reader = requireReader(req);
    const body = parseOr400(BatchBody, req.body, reply);
    if (!body) return reply;
    const now = Date.now();
    const results = db.transaction(() =>
      body.updates.map(({ bookId, ...update }): ApplyResult => {
        try {
          loadVisibleBook(db, reader, bookId);
        } catch (err) {
          if (err instanceof ContentLockedError) return { bookId, status: "not_found" };
          throw err;
        }
        return apply(reader, bookId, update, now);
      }),
    );
    return { results };
  });

  /** Forget a position (e.g. "remove from Continue reading" or "start over"). */
  app.delete<{ Params: { bookId: string } }>("/api/progress/:bookId", async (req, reply) => {
    const reader = requireReader(req);
    loadVisibleBook(db, reader, req.params.bookId);
    db.delete(readingProgress)
      .where(and(eq(readingProgress.userId, reader.userId), eq(readingProgress.bookId, req.params.bookId)))
      .run();
    return reply.code(204).send();
  });
}
