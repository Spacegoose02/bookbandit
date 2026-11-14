/**
 * Barnaby chat API for everyone, plus the parent log and per-kid settings.
 * Admin settings, usage and the rating helper are in admin-routes.ts.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { users, books, aiMessages } from "../db/schema.js";
import { requireReader } from "../auth/plugin.js";
import { httpError } from "../auth/plugin.js";
import { canManage, loadManagedUser, loadVisibleUser } from "../auth/permissions.js";
import type { Reader } from "../auth/reader.js";
import { toReader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import type { AiContext } from "./context.js";
import { chatTurn, conversationMessages } from "./chat.js";
import { kidAccess, kidSettings, saveKidSettings, sentToday, KID_BLOCK_MESSAGES } from "./kids.js";
import { aiConversations } from "./schema.js";
import { getAiSettings, providerFor } from "./settings.js";
import type { JobRunner } from "../jobs/index.js";
import { embeddingStatus, meaningSearch } from "./embeddings.js";
import { AI_JOB_TYPES, latestJob, queueEmbedding } from "./jobs.js";
import { moreLikeThis, summaries } from "./recommend.js";
import { redactPersonalDetails } from "./privacy.js";
import { smartRequest } from "./smart-request.js";

const ChatBody = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  bookId: z.string().min(1).max(64).optional(),
  position: z.number().min(0).max(1).optional(),
  webSearch: z.boolean().optional(),
});

const ListQuery = z.object({
  bookId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** updatedAt cursor: conversations older than this */
  before: z.coerce.number().int().optional(),
});

const KidSettingsBody = z.object({
  enabled: z.boolean(),
  webSearch: z.boolean().default(false),
  dailyLimit: z.number().int().min(1).max(500),
});

const SimilarQuery = z.object({ limit: z.coerce.number().int().min(1).max(24).default(8) });
const SearchQuery = z.object({ q: z.string().trim().min(2).max(300), limit: z.coerce.number().int().min(1).max(50).default(12) });
const SmartRequestBody = z.object({ text: z.string().trim().min(3).max(500), forKidId: z.string().min(1).max(64).optional() });

type ConvRow = typeof aiConversations.$inferSelect;

export async function aiRoutes(app: FastifyInstance, ctx: AiContext & { runner: JobRunner }) {
  const { db } = ctx;

  /** Conversations as `viewer` sees them: a chat about a book the viewer can no longer open loses its title. */
  function convViews(viewer: Reader, rows: ConvRow[]) {
    const bookIds = [...new Set(rows.map((r) => r.bookId).filter((x): x is string => !!x))];
    const visible = new Set(
      bookIds.length
        ? db.select({ id: books.id }).from(books).where(and(inArray(books.id, bookIds), visibleBooksWhere(viewer))).all().map((b) => b.id)
        : [],
    );
    return rows.map((c) => {
      const hidden = !!c.bookId && !visible.has(c.bookId);
      return {
        id: c.id,
        title: hidden ? "A book chat" : c.title,
        bookId: hidden ? null : c.bookId,
        kid: c.kid,
        flagged: c.flagged,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });
  }

  function listFor(userId: string, q: z.infer<typeof ListQuery>) {
    return db
      .select()
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.userId, userId),
          q.bookId ? eq(aiConversations.bookId, q.bookId) : undefined,
          q.before ? lt(aiConversations.updatedAt, q.before) : undefined,
        ),
      )
      .orderBy(desc(aiConversations.updatedAt))
      .limit(q.limit)
      .all();
  }

  /** What the UI needs to decide whether to show Barnaby, and how. */
  app.get("/api/ai/status", async (req) => {
    const reader = requireReader(req);
    const s = getAiSettings(db, ctx.box);
    const configured = !!providerFor(s, reader.isKid ? "kidChat" : "chat");
    const searchReady = s.search.enabled && !!s.search.url;
    const meaning = !!providerFor(s, "embeddings") && meaningAllowed(reader);
    if (!reader.isKid) {
      return {
        meaningSearch: meaning,
        smartRequests: configured,
        available: configured,
        reason: configured ? null : "not_configured",
        message: configured ? null : "Barnaby isn't set up yet. An admin can add an AI provider in settings.",
        kid: false,
        webSearch: searchReady,
        bookChat: !!providerFor(s, "bookChat"),
        remainingToday: null,
      };
    }
    const access = kidAccess(db, reader, kidSettings(db, reader.userId, s.kidDefaults), ctx.now());
    const reason = !configured ? "not_configured" : (access.reason ?? null);
    return {
      meaningSearch: meaning,
      smartRequests: false,
      available: configured && access.allowed,
      reason,
      message: reason === "not_configured" ? "Barnaby is asleep right now. Ask a grown-up to wake him up!" : reason ? KID_BLOCK_MESSAGES[reason] : null,
      kid: true,
      webSearch: searchReady && access.webSearch,
      bookChat: configured && access.allowed,
      remainingToday: access.remainingToday,
    };
  });

  app.post("/api/ai/chat", async (req) => {
    const reader = requireReader(req);
    return chatTurn(ctx, reader, ChatBody.parse(req.body));
  });

  /**
   * Same as /api/ai/chat, answered as server-sent events: `delta` ({ text }) while the reply is
   * written, then `done` (the same body /api/ai/chat returns), or `error` ({ statusCode, code,
   * message }) if it fails part-way. Checks that fail before the model is called (kid limits,
   * not configured, a locked book) are plain JSON errors with their status code, as on /chat.
   */
  app.post("/api/ai/chat/stream", async (req, reply) => {
    const reader = requireReader(req);
    const body = ChatBody.parse(req.body);
    let started = false;
    const send = (event: string, data: unknown) => {
      if (!started) {
        started = true;
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        });
      }
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const result = await chatTurn(ctx, reader, body, { onDelta: (text) => send("delta", { text }) });
      send("done", result);
    } catch (e) {
      if (!started) throw e;
      const err = e as Error & { statusCode?: number; code?: string };
      send("error", { statusCode: err.statusCode ?? 502, code: err.code ?? null, message: err.message });
    }
    reply.raw.end();
  });

  // ---- Finding books -----------------------------------------------------------

  /** Kids get meaning search only when a parent has turned Barnaby on for them. */
  function meaningAllowed(reader: Reader): boolean {
    if (!reader.isKid) return true;
    const access = kidAccess(db, reader, kidSettings(db, reader.userId, getAiSettings(db, ctx.box).kidDefaults), ctx.now());
    return access.allowed || access.reason === "daily_limit";
  }

  /** New books since the last index: queue a refresh, at most every 10 minutes. */
  function refreshIndexIfStale() {
    const st = embeddingStatus(ctx);
    if (!st.configured || st.indexed >= st.total) return;
    const last = latestJob(ctx, AI_JOB_TYPES.embed);
    if (last && (last.status === "queued" || last.status === "running" || ctx.now().getTime() - last.createdAt < 10 * 60_000)) return;
    queueEmbedding(ctx, ctx.runner, null);
  }

  /** "More like this": works without AI (shared series, authors, genres); embeddings add similar stories. */
  app.get<{ Params: { id: string } }>("/api/ai/books/:id/similar", async (req) => {
    const reader = requireReader(req);
    const q = SimilarQuery.parse(req.query);
    return { items: moreLikeThis(ctx, reader, req.params.id, q.limit) };
  });

  /**
   * Meaning search: books whose story is closest to `q`, behind the content lock. The web app
   * shows these under the normal title/author matches. `available: false` when not set up.
   */
  app.get("/api/ai/search", async (req) => {
    const reader = requireReader(req);
    const q = SearchQuery.parse(req.query);
    if (!meaningAllowed(reader)) return { available: false, items: [] };
    const text = reader.isKid ? redactPersonalDetails(q.q).text : q.q;
    let hits;
    try {
      hits = await meaningSearch(ctx, reader, text, q.limit);
    } catch (e) {
      req.log.warn({ err: e }, "meaning search failed");
      return { available: true, items: [], error: "Barnaby's meaning search isn't answering right now." };
    }
    if (hits === null) return { available: false, items: [] };
    refreshIndexIfStale();
    const score = new Map(hits.map((h) => [h.bookId, Math.round(h.score * 1000) / 1000]));
    return { available: true, items: summaries(db, reader, hits.map((h) => h.bookId), ctx.now()).map((b) => ({ ...b, score: score.get(b.id) ?? 0 })) };
  });

  /** "Something like Pixel Quest for a 10-year-old". Grown-ups only; see smart-request.ts. */
  app.post("/api/ai/smart-request", async (req) => {
    const reader = requireReader(req);
    return smartRequest(ctx, reader, SmartRequestBody.parse(req.body));
  });

  app.get("/api/ai/conversations", async (req) => {
    const reader = requireReader(req);
    const q = ListQuery.parse(req.query);
    return { items: convViews(reader, listFor(reader.userId, q)).filter((c) => !q.bookId || c.bookId) };
  });

  function ownConversation(reader: Reader, id: string): ConvRow {
    const c = db.select().from(aiConversations).where(and(eq(aiConversations.id, id), eq(aiConversations.userId, reader.userId))).get();
    if (!c) throw httpError(404, "Not found");
    return c;
  }

  app.get<{ Params: { id: string } }>("/api/ai/conversations/:id", async (req) => {
    const reader = requireReader(req);
    const c = ownConversation(reader, req.params.id);
    const [conv] = convViews(reader, [c]);
    // A kid's chat about a book that's now locked for them disappears entirely.
    if (c.bookId && !conv!.bookId) throw httpError(404, "Not found");
    return { conversation: conv, messages: conversationMessages(db, reader, c.id) };
  });

  /** Grown-ups can delete their own chats. Kids' chats stay in the parent log. */
  app.delete<{ Params: { id: string } }>("/api/ai/conversations/:id", async (req, reply) => {
    const reader = requireReader(req);
    const c = ownConversation(reader, req.params.id);
    if (reader.isKid || c.kid) throw httpError(403, "Kids' chats are kept for their parents");
    db.delete(aiMessages).where(eq(aiMessages.conversationId, c.id)).run();
    db.delete(aiConversations).where(eq(aiConversations.id, c.id)).run();
    reply.code(204);
  });

  // ---- Parents: kid settings and the chat log ------------------------------

  /** Kids this person manages (linked parent or admin), with their Barnaby settings and today's use. */
  app.get("/api/ai/kids", async (req) => {
    const reader = requireReader(req);
    if (reader.isKid) return { items: [] };
    const s = getAiSettings(db, ctx.box);
    const now = ctx.now();
    const kids = db
      .select()
      .from(users)
      .where(and(eq(users.householdId, reader.householdId), eq(users.role, "kid")))
      .orderBy(users.displayName)
      .all()
      .filter((u) => canManage(db, reader, u));
    return {
      items: kids.map((k) => {
        const ks = kidSettings(db, k.id, s.kidDefaults);
        const access = kidAccess(db, toReader(k), ks, now);
        const flagged =
          db
            .select({ n: sql<number>`count(*)` })
            .from(aiConversations)
            .where(and(eq(aiConversations.userId, k.id), eq(aiConversations.flagged, true)))
            .get()?.n ?? 0;
        return {
          id: k.id,
          displayName: k.displayName,
          avatar: k.avatar,
          age: access.age,
          settings: ks,
          status: access.allowed ? "on" : access.reason,
          sentToday: sentToday(db, k.id, now),
          flaggedConversations: flagged,
        };
      }),
    };
  });

  app.get<{ Params: { kidId: string } }>("/api/ai/kids/:kidId/settings", async (req) => {
    const reader = requireReader(req);
    const kid = loadVisibleUser(db, reader, req.params.kidId);
    if (kid.role !== "kid") throw httpError(404, "Not found");
    return kidSettings(db, kid.id, getAiSettings(db, ctx.box).kidDefaults);
  });

  /** Only a linked parent or an admin (CLAUDE.md rule 2). */
  app.put<{ Params: { kidId: string } }>("/api/ai/kids/:kidId/settings", async (req) => {
    const reader = requireReader(req);
    const kid = loadManagedUser(db, reader, req.params.kidId);
    if (kid.role !== "kid") throw httpError(404, "Not found");
    const body = KidSettingsBody.parse(req.body);
    saveKidSettings(db, kid.id, reader.userId, body, ctx.now().getTime());
    return kidSettings(db, kid.id, getAiSettings(db, ctx.box).kidDefaults);
  });

  app.get<{ Params: { kidId: string } }>("/api/ai/kids/:kidId/conversations", async (req) => {
    const reader = requireReader(req);
    const kid = loadManagedUser(db, reader, req.params.kidId);
    if (kid.role !== "kid") throw httpError(404, "Not found");
    const q = ListQuery.parse(req.query);
    return { items: convViews(reader, listFor(kid.id, q)) };
  });

  app.get<{ Params: { kidId: string; id: string } }>("/api/ai/kids/:kidId/conversations/:id", async (req) => {
    const reader = requireReader(req);
    const kid = loadManagedUser(db, reader, req.params.kidId);
    const c = db.select().from(aiConversations).where(and(eq(aiConversations.id, req.params.id), eq(aiConversations.userId, kid.id))).get();
    if (!c) throw httpError(404, "Not found");
    return { conversation: convViews(reader, [c])[0], messages: conversationMessages(db, reader, c.id) };
  });
}
