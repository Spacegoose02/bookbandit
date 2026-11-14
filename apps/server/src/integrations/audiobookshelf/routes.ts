/**
 * Audiobookshelf routes.
 *
 * Readers: play a linked audiobook through Bookbandit (content lock applies; the ABS token
 * stays on the server) and sync their listening position across devices.
 * Admins: configure the connection and link books to ABS items (by hand or automatically).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, requireReader } from "../../auth/plugin.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../../content/lock.js";
import { authors, bookAuthors, books } from "../../db/schema.js";
import { audioProgress } from "../schema.js";
import { httpError, type IntegrationsContext } from "../context.js";
import {
  AbsSettingsInput,
  getAbsSettings,
  publicAbsSettings,
  saveAbsSettings,
  type AbsSettings,
} from "../settings.js";
import { AbsError, AudiobookshelfClient, type AbsItemDetail, type AbsItemSummary } from "./client.js";
import { matchBooks, type BookForMatch } from "./match.js";

const IdParams = z.object({ id: z.string().min(1) });
const TrackParams = IdParams.extend({ index: z.coerce.number().int().min(0) });

const ProgressBody = z.object({
  currentTime: z.number().min(0),
  duration: z.number().min(0),
  finished: z.boolean().optional(),
  deviceName: z.string().max(100).optional(),
  /** Client clock in ms. Newest wins, so an offline tablet can't rewind a newer position. */
  clientUpdatedAt: z.number().int().positive(),
});

const LinkBody = z.object({ absItemId: z.string().min(1) });
const AutoLinkBody = z.object({ dryRun: z.boolean().default(false) });
const ItemsQuery = z.object({ q: z.string().optional(), unlinked: z.coerce.boolean().optional() });

const DETAIL_TTL_MS = 60_000;

export async function audiobookshelfRoutes(app: FastifyInstance, ctx: IntegrationsContext) {
  const { db, box } = ctx;
  const detailCache = new Map<string, { at: number; detail: AbsItemDetail }>();

  function settingsOrNull(): AbsSettings | null {
    return getAbsSettings(db, box);
  }

  function client(): AudiobookshelfClient {
    const s = settingsOrNull();
    if (!s || !s.enabled) throw httpError(503, "Audiobookshelf is not connected");
    return new AudiobookshelfClient(s.url, s.token, ctx.fetchImpl);
  }

  async function detail(absItemId: string): Promise<AbsItemDetail> {
    const hit = detailCache.get(absItemId);
    if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.detail;
    const d = await client().item(absItemId);
    detailCache.set(absItemId, { at: Date.now(), detail: d });
    return d;
  }

  /** A visible book with an audiobook, or 404 (never reveal locked books). */
  function linkedBookFor(reader: Parameters<typeof assertCanSee>[0], bookId: string) {
    const book = db.select().from(books).where(eq(books.id, bookId)).get();
    if (!book) throw new ContentLockedError();
    assertCanSee(reader, book);
    if (!book.absItemId) throw httpError(404, "This book has no audiobook");
    return book as typeof book & { absItemId: string };
  }

  async function absItems(c: AudiobookshelfClient, s: AbsSettings): Promise<AbsItemSummary[]> {
    const libs = s.libraryIds.length
      ? s.libraryIds
      : (await c.libraries()).filter((l) => l.mediaType === "book").map((l) => l.id);
    const lists = await Promise.all(libs.map((id) => c.libraryItems(id)));
    return lists.flat();
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof AbsError) {
      req.log.warn({ err }, "audiobookshelf request failed");
      return reply.code(err.status === 404 ? 404 : 502).send({ error: "Audiobookshelf request failed" });
    }
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    return reply.send(err);
  });

  // ---------------------------------------------------------------- readers

  app.get("/api/books/:id/audio", async (req) => {
    const reader = requireReader(req);
    const { id } = IdParams.parse(req.params);
    const book = linkedBookFor(reader, id);
    const d = await detail(book.absItemId);
    const progress = db
      .select()
      .from(audioProgress)
      .where(and(eq(audioProgress.userId, reader.userId), eq(audioProgress.bookId, id)))
      .get();
    return {
      bookId: id,
      title: d.title || book.title,
      author: d.authorName,
      narrator: d.narratorName,
      duration: d.duration,
      chapters: d.chapters,
      coverUrl: `/api/books/${id}/audio/cover`,
      tracks: d.tracks.map((t) => ({
        index: t.index,
        title: t.title,
        startOffset: t.startOffset,
        duration: t.duration,
        mimeType: t.mimeType,
        url: `/api/books/${id}/audio/tracks/${t.index}`,
      })),
      progress: progress && progress.absItemId === book.absItemId ? publicProgress(progress) : null,
    };
  });

  app.get("/api/books/:id/audio/tracks/:index", async (req, reply) => {
    const reader = requireReader(req);
    const { id, index } = TrackParams.parse(req.params);
    const book = linkedBookFor(reader, id);
    const track = (await detail(book.absItemId)).tracks[index];
    if (!track) throw httpError(404, "No such track");
    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    const upstream = await client().streamFile(book.absItemId, track.ino, range);
    return pipe(reply, upstream, ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]);
  });

  app.get("/api/books/:id/audio/cover", async (req, reply) => {
    const reader = requireReader(req);
    const { id } = IdParams.parse(req.params);
    const book = linkedBookFor(reader, id);
    const upstream = await client().cover(book.absItemId);
    reply.header("cache-control", "private, max-age=86400");
    return pipe(reply, upstream, ["content-type", "content-length"]);
  });

  app.get("/api/books/:id/audio/progress", async (req) => {
    const reader = requireReader(req);
    const { id } = IdParams.parse(req.params);
    const book = linkedBookFor(reader, id);
    const row = db
      .select()
      .from(audioProgress)
      .where(and(eq(audioProgress.userId, reader.userId), eq(audioProgress.bookId, id)))
      .get();
    return { progress: row && row.absItemId === book.absItemId ? publicProgress(row) : null };
  });

  app.put("/api/books/:id/audio/progress", async (req) => {
    const reader = requireReader(req);
    const { id } = IdParams.parse(req.params);
    const body = ProgressBody.parse(req.body);
    const book = linkedBookFor(reader, id);
    const current = db
      .select()
      .from(audioProgress)
      .where(and(eq(audioProgress.userId, reader.userId), eq(audioProgress.bookId, id)))
      .get();

    const sameItem = current?.absItemId === book.absItemId;
    if (current && sameItem && current.clientUpdatedAt >= body.clientUpdatedAt) {
      return { applied: false, progress: publicProgress(current) };
    }
    const finished = body.finished ?? (body.duration > 0 && body.currentTime >= body.duration - 30);
    const values = {
      userId: reader.userId,
      bookId: id,
      absItemId: book.absItemId,
      currentTime: Math.min(body.currentTime, body.duration || body.currentTime),
      duration: body.duration,
      finished,
      deviceName: body.deviceName ?? null,
      clientUpdatedAt: body.clientUpdatedAt,
      serverUpdatedAt: Date.now(),
    };
    db.insert(audioProgress)
      .values(values)
      .onConflictDoUpdate({ target: [audioProgress.userId, audioProgress.bookId], set: values })
      .run();
    return { applied: true, progress: publicProgress(values) };
  });

  /** "Keep listening" shelf: the reader's unfinished audiobooks they can still see. */
  app.get("/api/audio/continue", async (req) => {
    const reader = requireReader(req);
    const rows = db
      .select({ book: { id: books.id, title: books.title, coverPath: books.coverPath }, progress: audioProgress })
      .from(audioProgress)
      .innerJoin(books, eq(books.id, audioProgress.bookId))
      .where(
        and(
          eq(audioProgress.userId, reader.userId),
          eq(audioProgress.finished, false),
          eq(audioProgress.absItemId, books.absItemId),
          visibleBooksWhere(reader),
        ),
      )
      .orderBy(desc(audioProgress.serverUpdatedAt))
      .limit(20)
      .all();
    return { items: rows.map((r) => ({ ...r.book, progress: publicProgress(r.progress) })) };
  });

  // ---------------------------------------------------------------- admins

  app.get("/api/admin/integrations/audiobookshelf", async (req) => {
    requireAdmin(req);
    return publicAbsSettings(settingsOrNull());
  });

  app.put("/api/admin/integrations/audiobookshelf", async (req) => {
    requireAdmin(req);
    const input = AbsSettingsInput.parse(req.body);
    const saved = saveAbsSettings(db, box, input);
    detailCache.clear();
    return publicAbsSettings(saved);
  });

  app.post("/api/admin/integrations/audiobookshelf/test", async (req) => {
    requireAdmin(req);
    const c = client();
    const me = await c.ping();
    const libraries = await c.libraries();
    return { ok: true, username: me.username, libraries };
  });

  app.get("/api/admin/audiobookshelf/items", async (req) => {
    requireAdmin(req);
    const q = ItemsQuery.parse(req.query);
    const s = settingsOrNull();
    if (!s?.enabled) throw httpError(503, "Audiobookshelf is not connected");
    let items = await absItems(client(), s);
    if (q.q) {
      const needle = q.q.toLowerCase();
      items = items.filter((i) => `${i.title} ${i.authorName ?? ""}`.toLowerCase().includes(needle));
    }
    const ids = items.map((i) => i.id);
    const linked = new Map(
      ids.length
        ? db
            .select({ id: books.id, absItemId: books.absItemId })
            .from(books)
            .where(inArray(books.absItemId, ids))
            .all()
            .map((b) => [b.absItemId!, b.id])
        : [],
    );
    const out = items.map((i) => ({ ...i, linkedBookId: linked.get(i.id) ?? null }));
    return { items: q.unlinked ? out.filter((i) => !i.linkedBookId) : out };
  });

  app.put("/api/admin/books/:id/audiobookshelf", async (req) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    const { absItemId } = LinkBody.parse(req.body);
    const book = db.select({ id: books.id }).from(books).where(eq(books.id, id)).get();
    if (!book) throw httpError(404, "Not found");
    const other = db
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(and(eq(books.absItemId, absItemId), ne(books.id, id)))
      .get();
    if (other) throw httpError(409, `That audiobook is already linked to "${other.title}"`);
    const item = await client().item(absItemId); // 404 from ABS → 404 here
    db.update(books).set({ absItemId, updatedAt: Date.now() }).where(eq(books.id, id)).run();
    return { bookId: id, absItemId, title: item.title, duration: item.duration };
  });

  app.delete("/api/admin/books/:id/audiobookshelf", async (req, reply) => {
    requireAdmin(req);
    const { id } = IdParams.parse(req.params);
    db.update(books).set({ absItemId: null, updatedAt: Date.now() }).where(eq(books.id, id)).run();
    return reply.code(204).send();
  });

  app.post("/api/admin/audiobookshelf/auto-link", async (req) => {
    requireAdmin(req);
    const { dryRun } = AutoLinkBody.parse(req.body ?? {});
    const s = settingsOrNull();
    if (!s?.enabled) throw httpError(503, "Audiobookshelf is not connected");
    const items = await absItems(client(), s);

    const alreadyLinked = new Set(
      db
        .select({ absItemId: books.absItemId })
        .from(books)
        .all()
        .map((b) => b.absItemId)
        .filter(Boolean),
    );
    const free = items.filter((i) => !alreadyLinked.has(i.id));
    const unlinked = db
      .select({ id: books.id, title: books.title, isbn13: books.isbn13, kindleAsin: books.kindleAsin })
      .from(books)
      .where(isNull(books.absItemId))
      .all();
    const authorRows = unlinked.length
      ? db
          .select({ bookId: bookAuthors.bookId, name: authors.name })
          .from(bookAuthors)
          .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
          .where(inArray(bookAuthors.bookId, unlinked.map((b) => b.id)))
          .all()
      : [];
    const byBook = new Map<string, string[]>();
    for (const r of authorRows) byBook.set(r.bookId, [...(byBook.get(r.bookId) ?? []), r.name]);
    const candidates: BookForMatch[] = unlinked.map((b) => ({ ...b, authors: byBook.get(b.id) ?? [] }));

    const matches = matchBooks(candidates, free);
    if (!dryRun && matches.length) {
      const now = Date.now();
      db.transaction((tx) => {
        for (const m of matches) {
          tx.update(books).set({ absItemId: m.absItemId, updatedAt: now }).where(and(eq(books.id, m.bookId), isNull(books.absItemId))).run();
        }
      });
    }
    const titles = new Map(unlinked.map((b) => [b.id, b.title]));
    const itemTitles = new Map(free.map((i) => [i.id, i.title]));
    return {
      dryRun,
      linked: matches.map((m) => ({ ...m, bookTitle: titles.get(m.bookId), absTitle: itemTitles.get(m.absItemId) })),
      unmatchedBooks: unlinked.length - matches.length,
      unmatchedAudiobooks: free.length - matches.length,
    };
  });
}

function publicProgress(p: {
  currentTime: number;
  duration: number;
  finished: boolean;
  deviceName: string | null;
  clientUpdatedAt: number;
  serverUpdatedAt: number;
}) {
  return {
    currentTime: p.currentTime,
    duration: p.duration,
    percent: p.duration > 0 ? Math.min(1, p.currentTime / p.duration) : 0,
    finished: p.finished,
    deviceName: p.deviceName,
    clientUpdatedAt: p.clientUpdatedAt,
    serverUpdatedAt: p.serverUpdatedAt,
  };
}

function pipe(reply: FastifyReply, upstream: Response, headers: string[]) {
  reply.code(upstream.status);
  for (const h of headers) {
    const v = upstream.headers.get(h);
    if (v) reply.header(h, v);
  }
  if (!upstream.body) return reply.send();
  return reply.send(Readable.fromWeb(upstream.body as unknown as WebReadableStream));
}
