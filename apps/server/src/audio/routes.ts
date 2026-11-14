/**
 * Listening API, the same shape for local audiobooks and Audiobookshelf:
 *
 * Readers (content lock applies; a locked book or one without audio is a 404):
 *   GET  /api/books/:id/audio                  tracks, chapters, position, player settings
 *   GET  /api/books/:id/audio/tracks/:index    the audio, with Range (local file or ABS proxy)
 *   GET  /api/books/:id/audio/cover
 *   GET|PUT /api/books/:id/audio/progress      newest clientUpdatedAt wins; pushed to ABS
 *   PUT  /api/books/:id/audio/prefs            speed and skip-silence, remembered per book
 *   GET|POST /api/books/:id/audio/bookmarks    bookmarks with notes
 *   PATCH|DELETE /api/audio/bookmarks/:bookmarkId
 *   GET  /api/audio/continue                   "keep listening" shelf
 *
 * Admins:
 *   GET|POST /api/admin/audiobooks/scan        scan AUDIOBOOKS_DIR
 *   GET  /api/admin/audiobooks                 local audiobooks and the books they belong to
 *   plus the Audiobookshelf account and import routes in integrations/audiobookshelf/accounts.ts
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { and, asc, desc, eq, gt, isNull, like, or } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin, requireReader } from "../auth/plugin.js";
import type { Reader } from "../auth/reader.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, books } from "../db/schema.js";
import { audioProgress } from "../integrations/schema.js";
import type { SecretBox } from "../integrations/secrets.js";
import { getAbsSettings } from "../integrations/settings.js";
import { AbsError, AudiobookshelfClient, type AbsItemDetail, type FetchLike } from "../integrations/audiobookshelf/client.js";
import type { AbsSync } from "../integrations/audiobookshelf/sync.js";
import { insideRoot, sendFile } from "../library/serve.js";
import { audioBookmarks, audiobooks, audioPrefs } from "./schema.js";
import type { AudiobookService } from "./service.js";
import { progressMatchesBook, sourceFor, sourceKeys, type AudioSource } from "./sources.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const TrackParams = IdParams.extend({ index: z.coerce.number().int().min(0).max(100_000) });
const BookmarkParams = z.object({ bookmarkId: z.string().min(1).max(64) });

const ProgressBody = z.object({
  currentTime: z.number().min(0),
  duration: z.number().min(0),
  finished: z.boolean().optional(),
  deviceName: z.string().max(100).optional(),
  /** Client clock in ms. Newest wins, so an offline tablet can't rewind a newer position. */
  clientUpdatedAt: z.number().int().positive(),
});
const PrefsBody = z
  .object({ speed: z.number().min(0.5).max(3.5).optional(), skipSilence: z.boolean().optional() })
  .refine((b) => b.speed != null || b.skipSilence != null, "nothing to change");
const BookmarkBody = z.object({ time: z.number().min(0), note: z.string().max(2000).optional() });
const BookmarkPatch = z
  .object({ time: z.number().min(0).optional(), note: z.string().max(2000).nullable().optional() })
  .refine((b) => b.time != null || b.note !== undefined, "nothing to change");
const SinceQuery = z.object({ since: z.coerce.number().int().min(0).optional() });
const AdminListQuery = z.object({ q: z.string().max(200).optional() });

const DETAIL_TTL_MS = 60_000;
const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export interface AudioRouteOptions {
  db: Db;
  box: SecretBox;
  fetchImpl: FetchLike;
  audiobooksDir: string;
  configDir: string;
  service: AudiobookService;
  sync: AbsSync;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export async function audioRoutes(app: FastifyInstance, opts: AudioRouteOptions) {
  const { db, box, sync, service } = opts;
  const audioRoot = resolve(opts.audiobooksDir);
  const configRoot = resolve(opts.configDir);
  /** Keyed by ABS URL + item, so changing the ABS server never serves a stale item. */
  const detailCache = new Map<string, { at: number; detail: AbsItemDetail }>();

  function absClient(): AudiobookshelfClient {
    const s = getAbsSettings(db, box);
    if (!s || !s.enabled) throw httpError(503, "Audiobookshelf is not connected");
    return new AudiobookshelfClient(s.url, s.token, opts.fetchImpl);
  }

  async function absDetail(absItemId: string): Promise<AbsItemDetail> {
    const s = getAbsSettings(db, box);
    const key = `${s?.url}|${absItemId}`;
    const hit = detailCache.get(key);
    if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.detail;
    const d = await absClient().item(absItemId);
    detailCache.set(key, { at: Date.now(), detail: d });
    return d;
  }

  /** A book the reader may see that has audio, or 404 (never reveal locked books). */
  function audioBookFor(reader: Reader, bookId: string) {
    const book = db.select().from(books).where(eq(books.id, bookId)).get();
    if (!book) throw new ContentLockedError();
    assertCanSee(reader, book);
    const source = sourceFor(db, book);
    if (!source) throw httpError(404, "This book has no audiobook");
    return { book, source };
  }

  function progressFor(reader: Reader, book: { id: string; absItemId: string | null }) {
    const row = db
      .select()
      .from(audioProgress)
      .where(and(eq(audioProgress.userId, reader.userId), eq(audioProgress.bookId, book.id)))
      .get();
    return row && sourceKeys(db, book).includes(row.absItemId) ? row : undefined;
  }

  function prefsFor(reader: Reader, bookId: string) {
    const row = db
      .select()
      .from(audioPrefs)
      .where(and(eq(audioPrefs.userId, reader.userId), eq(audioPrefs.bookId, bookId)))
      .get();
    return { speed: row?.speed ?? 1, skipSilence: row?.skipSilence ?? false };
  }

  async function describe(source: AudioSource, bookId: string, title: string) {
    const trackUrl = (i: number) => `/api/books/${bookId}/audio/tracks/${i}`;
    if (source.kind === "local") {
      const a = source.audiobook;
      return {
        source: "local" as const,
        title,
        author: null as string | null,
        narrator: a.narrator,
        duration: a.duration,
        chapters: a.chapters,
        tracks: a.tracks.map((t, index) => ({
          index,
          title: t.title,
          startOffset: t.startOffset,
          duration: t.duration,
          mimeType: t.mimeType,
          url: trackUrl(index),
        })),
      };
    }
    const d = await absDetail(source.absItemId);
    return {
      source: "audiobookshelf" as const,
      title: d.title || title,
      author: d.authorName,
      narrator: d.narratorName,
      duration: d.duration,
      chapters: d.chapters,
      tracks: d.tracks.map((t) => ({
        index: t.index,
        title: t.title,
        startOffset: t.startOffset,
        duration: t.duration,
        mimeType: t.mimeType,
        url: trackUrl(t.index),
      })),
    };
  }

  function authorNames(bookId: string): string | null {
    const rows = db
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(and(eq(bookAuthors.bookId, bookId), eq(bookAuthors.role, "author")))
      .orderBy(asc(bookAuthors.position))
      .all();
    return rows.length ? rows.map((r) => r.name).join(", ") : null;
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof AbsError) {
      req.log.warn({ err }, "audiobookshelf request failed");
      return reply.code(err.status === 404 ? 404 : 502).send({ error: "Audiobookshelf request failed" });
    }
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    return reply.send(err);
  });

  // ---------------------------------------------------------------- playback

  app.get("/api/books/:id/audio", async (req) => {
    const reader = requireReader(req);
    const { id } = parseOr404(IdParams, req.params);
    const { book, source } = audioBookFor(reader, id);
    const info = await describe(source, id, book.title);
    await sync.pull(reader.userId, id, book.absItemId);
    const progress = progressFor(reader, book);
    return {
      bookId: id,
      ...info,
      author: info.author ?? authorNames(id),
      coverUrl: `/api/books/${id}/audio/cover`,
      progress: progress ? publicProgress(progress) : null,
      prefs: prefsFor(reader, id),
    };
  });

  app.get("/api/books/:id/audio/tracks/:index", async (req, reply) => {
    const reader = requireReader(req);
    const { id, index } = parseOr404(TrackParams, req.params);
    const { source } = audioBookFor(reader, id);
    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    if (source.kind === "local") {
      const track = source.audiobook.tracks[index];
      const abs = track ? insideRoot(audioRoot, track.relPath) : undefined;
      const info = abs ? await stat(abs).catch(() => undefined) : undefined;
      if (!track || !abs || !info?.isFile()) throw httpError(404, "No such track");
      const name = track.relPath.split("/").pop()!;
      return sendFile(reply, abs, info.size, track.mimeType, name, range);
    }
    const track = (await absDetail(source.absItemId)).tracks[index];
    if (!track) throw httpError(404, "No such track");
    const upstream = await absClient().streamFile(source.absItemId, track.ino, range);
    return pipe(reply, upstream, ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]);
  });

  app.get("/api/books/:id/audio/cover", async (req, reply) => {
    const reader = requireReader(req);
    const { id } = parseOr404(IdParams, req.params);
    const { book, source } = audioBookFor(reader, id);
    reply.header("cache-control", "private, max-age=86400");
    if (source.kind === "abs") {
      const upstream = await absClient().cover(source.absItemId);
      return pipe(reply, upstream, ["content-type", "content-length"]);
    }
    const candidates = [
      source.audiobook.coverRelPath ? insideRoot(audioRoot, source.audiobook.coverRelPath) : undefined,
      book.coverPath ? insideRoot(configRoot, book.coverPath) : undefined,
    ];
    for (const abs of candidates) {
      const ext = abs?.split(".").pop()?.toLowerCase() ?? "";
      const info = abs ? await stat(abs).catch(() => undefined) : undefined;
      if (!abs || !info?.isFile() || !IMAGE_TYPES[ext]) continue;
      reply.header("content-length", info.size);
      reply.type(IMAGE_TYPES[ext]!);
      return reply.send(createReadStream(abs));
    }
    throw httpError(404, "No cover");
  });

  // ---------------------------------------------------------------- progress

  app.get("/api/books/:id/audio/progress", async (req) => {
    const reader = requireReader(req);
    const { id } = parseOr404(IdParams, req.params);
    const { book } = audioBookFor(reader, id);
    const row = progressFor(reader, book);
    return { progress: row ? publicProgress(row) : null };
  });

  app.put("/api/books/:id/audio/progress", async (req) => {
    const reader = requireReader(req);
    const { id } = parseOr404(IdParams, req.params);
    const body = ProgressBody.parse(req.body);
    const { book, source } = audioBookFor(reader, id);
    const current = progressFor(reader, book);
    if (current && current.clientUpdatedAt >= body.clientUpdatedAt) {
      return { applied: false, progress: publicProgress(current) };
    }
    const finished = body.finished ?? (body.duration > 0 && body.currentTime >= body.duration - 30);
    const values = {
      userId: reader.userId,
      bookId: id,
      absItemId: source.key,
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
    sync.schedulePush(reader.userId, id);
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
          progressMatchesBook(),
          visibleBooksWhere(reader),
        ),
      )
      .orderBy(desc(audioProgress.serverUpdatedAt))
      .limit(20)
      .all();
    return { items: rows.map((r) => ({ ...r.book, progress: publicProgress(r.progress) })) };
  });

  // ---------------------------------------------------------------- player settings

  app.put("/api/books/:id/audio/prefs", async (req) => {
    const reader = requireReader(req);
    const { id } = parseOr404(IdParams, req.params);
    const body = PrefsBody.parse(req.body);
    audioBookFor(reader, id);
    const next = { ...prefsFor(reader, id), ...Object.fromEntries(Object.entries(body).filter(([, v]) => v != null)) };
    const values = { userId: reader.userId, bookId: id, speed: next.speed, skipSilence: next.skipSilence, updatedAt: Date.now() };
    db.insert(audioPrefs)
      .values(values)
      .onConflictDoUpdate({ target: [audioPrefs.userId, audioPrefs.bookId], set: values })
      .run();
    return { speed: values.speed, skipSilence: values.skipSilence };
  });

  // ---------------------------------------------------------------- bookmarks

  app.get("/api/books/:id/audio/bookmarks", async (req) => {
    const reader = requireReader(req);
    const { id } = parseOr404(IdParams, req.params);
    const { since } = SinceQuery.parse(req.query);
    audioBookFor(reader, id);
    const rows = db
      .select()
      .from(audioBookmarks)
      .where(
        and(
          eq(audioBookmarks.userId, reader.userId),
          eq(audioBookmarks.bookId, id),
          since != null ? gt(audioBookmarks.updatedAt, since) : isNull(audioBookmarks.deletedAt),
        ),
      )
      .orderBy(asc(audioBookmarks.time))
      .all();
    return { items: rows.map(publicBookmark), serverTime: Date.now() };
  });

  app.post("/api/books/:id/audio/bookmarks", async (req, reply) => {
    const reader = requireReader(req);
    const { id } = parseOr404(IdParams, req.params);
    const body = BookmarkBody.parse(req.body);
    audioBookFor(reader, id);
    const now = Date.now();
    const [row] = db
      .insert(audioBookmarks)
      .values({ userId: reader.userId, bookId: id, time: body.time, note: body.note?.trim() || null, createdAt: now, updatedAt: now })
      .returning()
      .all();
    return reply.code(201).send(publicBookmark(row!));
  });

  /** A bookmark of the reader's own, on a book they can still see; anything else is a 404. */
  function ownBookmark(reader: Reader, bookmarkId: string) {
    const row = db
      .select()
      .from(audioBookmarks)
      .where(and(eq(audioBookmarks.id, bookmarkId), eq(audioBookmarks.userId, reader.userId), isNull(audioBookmarks.deletedAt)))
      .get();
    if (!row) throw httpError(404, "Not found");
    const book = db.select().from(books).where(eq(books.id, row.bookId)).get();
    if (!book) throw new ContentLockedError();
    assertCanSee(reader, book);
    return row;
  }

  app.patch("/api/audio/bookmarks/:bookmarkId", async (req) => {
    const reader = requireReader(req);
    const { bookmarkId } = parseOr404(BookmarkParams, req.params);
    const body = BookmarkPatch.parse(req.body);
    const row = ownBookmark(reader, bookmarkId);
    const set: Partial<typeof audioBookmarks.$inferInsert> = { updatedAt: Date.now() };
    if (body.time != null) set.time = body.time;
    if (body.note !== undefined) set.note = body.note?.trim() || null;
    const [updated] = db.update(audioBookmarks).set(set).where(eq(audioBookmarks.id, row.id)).returning().all();
    return publicBookmark(updated!);
  });

  app.delete("/api/audio/bookmarks/:bookmarkId", async (req, reply) => {
    const reader = requireReader(req);
    const { bookmarkId } = parseOr404(BookmarkParams, req.params);
    const row = ownBookmark(reader, bookmarkId);
    const now = Date.now();
    db.update(audioBookmarks).set({ deletedAt: now, updatedAt: now }).where(eq(audioBookmarks.id, row.id)).run();
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- admin

  app.get("/api/admin/audiobooks/scan", async (req) => {
    requireAdmin(req);
    return { audiobooksDir: audioRoot, ...service.getStatus() };
  });

  app.post("/api/admin/audiobooks/scan", async (req, reply) => {
    requireAdmin(req);
    service.startScan().catch(() => {
      // reported through getStatus().lastError and the log
    });
    return reply.code(202).send({ audiobooksDir: audioRoot, ...service.getStatus() });
  });

  app.get("/api/admin/audiobooks", async (req) => {
    requireAdmin(req);
    const { q } = AdminListQuery.parse(req.query);
    const needle = q?.trim() ? `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : undefined;
    const rows = db
      .select({
        id: audiobooks.id,
        relPath: audiobooks.relPath,
        duration: audiobooks.duration,
        narrator: audiobooks.narrator,
        tracks: audiobooks.tracks,
        chapters: audiobooks.chapters,
        bookId: books.id,
        title: books.title,
        approved: books.approved,
        rating: books.rating,
        absItemId: books.absItemId,
      })
      .from(audiobooks)
      .innerJoin(books, eq(books.id, audiobooks.bookId))
      .where(needle ? or(like(books.title, needle), like(audiobooks.relPath, needle)) : undefined)
      .orderBy(asc(books.sortTitle))
      .limit(500)
      .all();
    return {
      items: rows.map(({ tracks, chapters, ...r }) => ({ ...r, trackCount: tracks.length, chapterCount: chapters.length })),
    };
  });
}

export function publicProgress(p: {
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

function publicBookmark(b: typeof audioBookmarks.$inferSelect) {
  return {
    id: b.id,
    bookId: b.bookId,
    time: b.time,
    note: b.note,
    origin: b.origin,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    deleted: b.deletedAt != null,
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

/** Bad ids look exactly like missing books: 404. */
function parseOr404<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) throw new ContentLockedError();
  return r.data;
}
