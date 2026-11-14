/**
 * Bookmarks, highlights and stickers (per profile, synced across devices).
 *
 * - Clients may pick the id (a UUID) so a bookmark made offline keeps the same id when it
 *   uploads; posting the same id twice is a no-op.
 * - Deletes are soft (`deletedAt`) so other devices learn about them on their next sync.
 * - `updatedAt` (server ms) is bumped on every change and is the incremental sync cursor.
 * - All reads and writes go through the content lock; locked books return 404.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { BOOKMARK_KINDS, type BookmarkRecord, type ReadingLocator } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { bookmarks, books } from "../db/schema.js";
import { requireReader } from "../auth/plugin.js";
import type { Reader } from "../auth/reader.js";
import { ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import { LocatorSchema, loadVisibleBook, parseOr400, SinceQuery } from "./progress.js";

const Color = z.string().regex(/^(#[0-9a-fA-F]{3,8}|[a-z]{1,20})$/, "hex like #ffcc00 or a color name");

const CreateBody = z.object({
  id: z.string().uuid().optional(),
  bookId: z.string().min(1).max(64),
  kind: z.enum(BOOKMARK_KINDS),
  locator: LocatorSchema,
  /** Highlighted text, or the sticker's name. */
  text: z.string().max(5000).nullish(),
  note: z.string().max(5000).nullish(),
  color: Color.nullish(),
});

const PatchBody = z
  .object({
    locator: LocatorSchema,
    text: z.string().max(5000).nullable(),
    note: z.string().max(5000).nullable(),
    color: Color.nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to change");

function toRecord(row: typeof bookmarks.$inferSelect): BookmarkRecord & { updatedAt: number } {
  return {
    id: row.id,
    bookId: row.bookId,
    kind: row.kind,
    locator: row.locator as ReadingLocator,
    text: row.text,
    note: row.note,
    color: row.color,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export async function bookmarkRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  /** The reader's own bookmark on a book they can still see, or 404. */
  function loadOwn(reader: Reader, id: string) {
    const row = db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.id, id), eq(bookmarks.userId, reader.userId)))
      .get();
    if (!row) throw new ContentLockedError();
    loadVisibleBook(db, reader, row.bookId);
    return row;
  }

  /** Live bookmarks for one book, oldest first. */
  app.get<{ Params: { bookId: string } }>("/api/books/:bookId/bookmarks", async (req) => {
    const reader = requireReader(req);
    loadVisibleBook(db, reader, req.params.bookId);
    const rows = db
      .select()
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.userId, reader.userId),
          eq(bookmarks.bookId, req.params.bookId),
          isNull(bookmarks.deletedAt),
        ),
      )
      .orderBy(asc(bookmarks.createdAt))
      .all();
    return { items: rows.map(toRecord) };
  });

  /**
   * Everything that changed after `since` (server ms), including deletions, for books the
   * reader can see. Without `since`, returns all live bookmarks. Pass `serverTime` back next time.
   */
  app.get("/api/bookmarks", async (req, reply) => {
    const reader = requireReader(req);
    const q = parseOr400(SinceQuery, req.query, reply);
    if (!q) return reply;
    // One ms behind so a write landing in this same ms is sent again next time, never missed.
    const serverTime = Date.now() - 1;
    const rows = db
      .select({ bookmark: bookmarks })
      .from(bookmarks)
      .innerJoin(books, eq(books.id, bookmarks.bookId))
      .where(
        and(
          eq(bookmarks.userId, reader.userId),
          visibleBooksWhere(reader),
          q.since === undefined ? isNull(bookmarks.deletedAt) : gt(bookmarks.updatedAt, q.since),
        ),
      )
      .orderBy(asc(bookmarks.updatedAt))
      .all();
    return { items: rows.map((r) => toRecord(r.bookmark)), serverTime };
  });

  app.post("/api/bookmarks", async (req, reply) => {
    const reader = requireReader(req);
    const body = parseOr400(CreateBody, req.body, reply);
    if (!body) return reply;
    loadVisibleBook(db, reader, body.bookId);

    if (body.id) {
      const existing = db.select().from(bookmarks).where(eq(bookmarks.id, body.id)).get();
      if (existing) {
        // Same upload retried: return what we already have. Someone else's id: don't reveal it.
        if (existing.userId !== reader.userId) return reply.code(409).send({ error: "Id already in use" });
        return reply.code(200).send(toRecord(existing));
      }
    }

    const now = Date.now();
    const [row] = db
      .insert(bookmarks)
      .values({
        ...(body.id ? { id: body.id } : {}),
        userId: reader.userId,
        bookId: body.bookId,
        kind: body.kind,
        locator: body.locator,
        text: body.text ?? null,
        note: body.note ?? null,
        color: body.color ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();
    return reply.code(201).send(toRecord(row!));
  });

  app.patch<{ Params: { id: string } }>("/api/bookmarks/:id", async (req, reply) => {
    const reader = requireReader(req);
    const body = parseOr400(PatchBody, req.body, reply);
    if (!body) return reply;
    const current = loadOwn(reader, req.params.id);
    if (current.deletedAt != null) throw new ContentLockedError();
    const [row] = db
      .update(bookmarks)
      .set({ ...body, updatedAt: Math.max(Date.now(), current.updatedAt + 1) })
      .where(eq(bookmarks.id, current.id))
      .returning()
      .all();
    return toRecord(row!);
  });

  app.delete<{ Params: { id: string } }>("/api/bookmarks/:id", async (req, reply) => {
    const reader = requireReader(req);
    const current = loadOwn(reader, req.params.id);
    if (current.deletedAt == null) {
      const now = Math.max(Date.now(), current.updatedAt + 1);
      db.update(bookmarks).set({ deletedAt: now, updatedAt: now }).where(eq(bookmarks.id, current.id)).run();
    }
    return reply.code(204).send();
  });
}
