/**
 * Read-aloud API. See README.md in this folder.
 *
 * Book-related calls check the content lock as the reader (CLAUDE.md rule 1): a locked book's
 * status and speech both 404. Settings are admin-only; a person's own voice and speed are theirs
 * to pick, and a linked parent or admin can set them for a kid.
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { httpError, requireAdmin, requireReader } from "../auth/plugin.js";
import { canManage, loadVisibleUser } from "../auth/permissions.js";
import type { Reader } from "../auth/reader.js";
import { assertCanSee } from "../content/lock.js";
import type { Db } from "../db/client.js";
import { bookFiles, books } from "../db/schema.js";
import type { SecretBox } from "../integrations/secrets.js";
import { CLIP_ID, ClipCache, clipKey } from "./cache.js";
import { hasMediaOverlay } from "./overlays.js";
import { narrationPrefs } from "./schema.js";
import { getNarrationSettings, publicNarrationSettings, saveNarrationSettings, type NarrationSettings } from "./settings.js";
import { listVoices, synthesize, type FetchLike } from "./tts.js";

export interface NarrationContext {
  db: Db;
  box: SecretBox;
  booksDir: string;
  cache: ClipCache;
  fetchImpl: FetchLike;
}

const PersonParams = z.object({ userId: z.string().min(1).max(64) });
const StatusQuery = z.object({ bookId: z.string().min(1).max(64).optional() });
const PrefsBody = z.object({ voice: z.string().min(1).max(100).nullable(), speed: z.number().min(0.5).max(2) });
/** One sentence or a short paragraph at a time, so the first words play quickly. */
const SpeechBody = z.object({ bookId: z.string().min(1).max(64), text: z.string().trim().min(1).max(1000), voice: z.string().min(1).max(100).optional() });
const ClipParams = z.object({ id: z.string().regex(CLIP_ID) });
const TestBody = z.object({ text: z.string().max(300).optional(), voice: z.string().max(100).optional() });

export const EPUB_FORMATS = ["epub", "kepub"] as const;

export function voiceFor(s: NarrationSettings, reader: Pick<Reader, "role">, pref: { voice: string | null } | undefined): string {
  return pref?.voice ?? (reader.role === "kid" ? s.kidVoice : null) ?? s.defaultVoice;
}

export async function narrationRoutes(app: FastifyInstance, ctx: NarrationContext) {
  const { db, box } = ctx;

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Bad request", message: "Invalid request", issues: err.issues });
    return reply.send(err);
  });

  const settingsNow = () => getNarrationSettings(db, box);
  const prefOf = (userId: string) => db.select().from(narrationPrefs).where(eq(narrationPrefs.userId, userId)).get();

  function visibleBook(reader: Reader, bookId: string) {
    const book = db.select({ id: books.id, rating: books.rating, approved: books.approved }).from(books).where(eq(books.id, bookId)).get();
    if (!book) throw httpError(404, "Not found");
    assertCanSee(reader, book);
    return book;
  }

  /** What the read-aloud button needs: is a voice server on, which voice, does this book have a recorded narrator. */
  app.get("/api/narration/status", async (req) => {
    const reader = requireReader(req);
    const { bookId } = StatusQuery.parse(req.query);
    const s = settingsNow();
    let mediaOverlay = false;
    if (bookId) {
      visibleBook(reader, bookId);
      const file = db
        .select({ relPath: bookFiles.relPath, format: bookFiles.format })
        .from(bookFiles)
        .where(eq(bookFiles.bookId, bookId))
        .all()
        .find((f) => (EPUB_FORMATS as readonly string[]).includes(f.format));
      if (file) mediaOverlay = await hasMediaOverlay(ctx.booksDir, file.relPath);
    }
    const pref = prefOf(reader.userId);
    return {
      server: s.enabled && !!s.baseUrl,
      voice: voiceFor(s, reader, pref),
      speed: pref?.speed ?? 1,
      wordTimings: s.enabled && s.wordTimings,
      mediaOverlay,
    };
  });

  app.get("/api/narration/voices", async (req) => {
    requireReader(req);
    const s = settingsNow();
    if (!s.enabled) return { voices: [], defaultVoice: s.defaultVoice, kidVoice: s.kidVoice };
    return { voices: await listVoices(ctx.fetchImpl, s), defaultVoice: s.defaultVoice, kidVoice: s.kidVoice };
  });

  function person(viewer: Reader, param: string) {
    const u = loadVisibleUser(db, viewer, param === "me" ? viewer.userId : param);
    return { user: u, canEdit: u.id === viewer.userId || canManage(db, viewer, u) };
  }

  app.get("/api/narration/people/:userId", async (req) => {
    const viewer = requireReader(req);
    const { user, canEdit } = person(viewer, PersonParams.parse(req.params).userId);
    const s = settingsNow();
    const pref = prefOf(user.id);
    return { userId: user.id, voice: pref?.voice ?? null, speed: pref?.speed ?? 1, effectiveVoice: voiceFor(s, user, pref), canEdit };
  });

  app.put("/api/narration/people/:userId", async (req) => {
    const viewer = requireReader(req);
    const { user, canEdit } = person(viewer, PersonParams.parse(req.params).userId);
    if (!canEdit) throw httpError(403, "Only a parent or admin can change this");
    const body = PrefsBody.parse(req.body);
    const values = { userId: user.id, voice: body.voice, speed: body.speed, updatedBy: viewer.userId, updatedAt: Date.now() };
    db.insert(narrationPrefs).values(values).onConflictDoUpdate({ target: narrationPrefs.userId, set: values }).run();
    return { userId: user.id, voice: body.voice, speed: body.speed, effectiveVoice: voiceFor(settingsNow(), user, values), canEdit };
  });

  /** Speak one piece of a book. Cached on disk, so the second reading of a chapter is free. */
  app.post("/api/narration/speech", async (req) => {
    const reader = requireReader(req);
    const body = SpeechBody.parse(req.body);
    visibleBook(reader, body.bookId);
    const s = settingsNow();
    if (!s.enabled || !s.baseUrl) throw httpError(409, "Read-aloud voices aren't set up on this server");
    const pref = prefOf(reader.userId);
    const voice = body.voice ?? voiceFor(s, reader, pref);
    const speed = pref?.speed ?? 1;
    const text = body.text.replace(/\s+/g, " ");
    const id = clipKey({ server: s.baseUrl, model: s.model, voice, speed, text });
    const { meta, cached } = await ctx.cache.getOrMake(id, () => synthesize(ctx.fetchImpl, s, { text, voice, speed }));
    return { id, url: `/api/narration/clips/${id}`, words: meta.words, cached, voice };
  });

  /** A cached clip. Ids are hashes of the text, so they reveal nothing and can't be guessed. */
  app.get("/api/narration/clips/:id", async (req, reply) => {
    requireReader(req);
    const { id } = ClipParams.parse(req.params);
    const meta = await ctx.cache.get(id);
    if (!meta) throw httpError(404, "Not found");
    const size = meta.bytes;
    reply.header("content-type", meta.contentType).header("accept-ranges", "bytes").header("cache-control", "private, max-age=604800, immutable");
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
      reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
      return reply.send(createReadStream(ctx.cache.audioPath(id), { start, end }));
    }
    reply.header("content-length", size);
    return reply.send(createReadStream(ctx.cache.audioPath(id)));
  });

  // --- admin -----------------------------------------------------------------
  app.get("/api/admin/narration/settings", async (req) => {
    requireAdmin(req);
    return { settings: publicNarrationSettings(settingsNow()), cache: await ctx.cache.usage(), cacheDir: ctx.cache.dir };
  });

  app.put("/api/admin/narration/settings", async (req) => {
    requireAdmin(req);
    const saved = saveNarrationSettings(db, box, req.body);
    void ctx.cache.trim().catch(() => undefined);
    return { settings: publicNarrationSettings(saved), cache: await ctx.cache.usage(), cacheDir: ctx.cache.dir };
  });

  /** Try the server with the saved settings: speaks a sentence (not cached) and lists voices. */
  app.post("/api/admin/narration/test", async (req) => {
    requireAdmin(req);
    const body = TestBody.parse(req.body ?? {});
    const s = settingsNow();
    if (!s.baseUrl) throw httpError(400, "Add the speech server's address first");
    const started = Date.now();
    try {
      const speech = await synthesize(ctx.fetchImpl, s, { text: body.text || "Hello! I'm Barnaby, and I love reading stories.", voice: body.voice || s.defaultVoice, speed: 1 });
      return { ok: true, ms: Date.now() - started, bytes: speech.audio.length, wordTimings: !!speech.words, voices: await listVoices(ctx.fetchImpl, s) };
    } catch (e) {
      return { ok: false, ms: Date.now() - started, error: (e as Error).message };
    }
  });

  app.delete("/api/admin/narration/cache", async (req, reply) => {
    requireAdmin(req);
    await ctx.cache.clear();
    return reply.code(204).send();
  });
}

export function defaultCacheDir(configDir: string) {
  return join(configDir, "cache", "narration");
}
