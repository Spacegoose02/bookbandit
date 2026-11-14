/** Admin-only Barnaby settings, provider tests, usage and the rating helper (CLAUDE.md rule 4). */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { CONTENT_RATINGS } from "@bookbandit/shared";
import { books } from "../db/schema.js";
import { httpError, requireAdmin } from "../auth/plugin.js";
import type { AiContext } from "./context.js";
import { makeProvider, ProviderError } from "./providers/index.js";
import type { JobRunner } from "../jobs/index.js";
import { AI_JOB_TYPES, batchStatus, failedBookIds, latestJob, queueEmbedding, startBatch } from "./jobs.js";
import { estimateCost, spentOn } from "./costs.js";
import { embeddingStatus } from "./embeddings.js";
import { acceptMetadata, listMetadataSuggestions, metadataCandidates, metadataProgress } from "./metadata.js";
import { ratingCandidates, ratingProgress } from "./rating.js";
import { acceptRatings, fileRatedBooks, pendingFixes } from "./review.js";
import { aiMetadataChecks, aiMetadataSuggestions } from "./schema.js";
import { aiRatingSuggestions } from "./schema.js";
import { webSearch } from "./search.js";
import { AI_FEATURES, AiSettingsInput, getAiSettings, providerFor, publicAiSettings, saveAiSettings } from "./settings.js";
import { tracked, usageSummary } from "./usage.js";

/** nomic-embed-text, mxbai-embed-large, text-embedding-3-small, bge-m3, all-minilm, snowflake-arctic-embed… */
const EMBEDDING_MODEL = /embed|\bbge\b|minilm|\bgte-|\be5-/i;

const TestBody = z.object({
  providerId: z.string().min(1),
  /** auto: chat, or embeddings for an embeddings model (and as a fallback when chat is refused). */
  mode: z.enum(["auto", "chat", "embeddings"]).default("auto"),
});
const SearchTestBody = z.object({ q: z.string().trim().min(1).max(300).default("dinosaurs"), kid: z.boolean().default(false) });
/** `all`: every book left, in one background run. `retryFailed`: just the books earlier runs couldn't read. */
const BatchChoice = {
  bookIds: z.array(z.string().min(1)).max(500).optional(),
  limit: z.number().int().min(1).max(500).default(25),
  all: z.boolean().default(false),
  retryFailed: z.boolean().default(false),
};
const RunBody = z.object({ ...BatchChoice, applyStricter: z.boolean().default(true) });
const SuggestionQuery = z.object({
  status: z.enum(["pending", "accepted", "applied", "dismissed"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** inbox: books not approved yet. library: approved books. */
  scope: z.enum(["all", "inbox", "library"]).default("all"),
});
const BookIdsBody = z.object({ bookIds: z.array(z.string().min(1).max(64)).min(1).max(1000) });
const AcceptBody = z.object({ rating: z.enum(CONTENT_RATINGS).optional() });
const MetadataRunBody = z.object(BatchChoice);
/** Plenty for "all": SQLite has no LIMIT ∞, and no family library is this big. */
const EVERYTHING = 1_000_000;
const MetadataQuery = z.object({
  status: z.enum(["pending", "accepted", "dismissed"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  scope: z.enum(["all", "inbox", "library"]).default("all"),
});
const MetadataAccept = z.object({ value: z.unknown().optional() });
const EmbedBody = z.object({ bookIds: z.array(z.string().min(1)).max(5000).optional() });

export async function aiAdminRoutes(app: FastifyInstance, ctx: AiContext & { runner: JobRunner }) {
  const { db } = ctx;

  app.get("/api/admin/ai/settings", async (req) => {
    requireAdmin(req);
    return publicAiSettings(getAiSettings(db, ctx.box));
  });

  app.put("/api/admin/ai/settings", async (req) => {
    const admin = requireAdmin(req);
    AiSettingsInput.parse(req.body); // 400 with zod details before touching anything
    const saved = saveAiSettings(db, ctx.box, req.body);
    // Turning filing on (or trusting confident ratings) applies to books already rated.
    fileRatedBooks(db, saved.ratingHelper);
    // A new or changed embeddings model: build the meaning-search index in the background.
    const emb = embeddingStatus(ctx);
    if (emb.configured && emb.indexed < emb.total) queueEmbedding(ctx, ctx.runner, admin.userId);
    return publicAiSettings(saved);
  });

  function provider(id: string) {
    const config = getAiSettings(db, ctx.box).providers.find((p) => p.id === id);
    if (!config) throw httpError(404, "No provider with that id");
    return makeProvider(config, ctx.fetchImpl);
  }

  /**
   * Sends a tiny prompt and reports the answer and how long it took. Embeddings models
   * (Ollama nomic-embed-text and friends) can't chat, so for those it embeds a short text
   * instead: up front when the model looks like one or is only used for meaning search, and
   * as a fallback when the server refuses the chat. Save settings first.
   */
  app.post("/api/admin/ai/providers/test", async (req) => {
    const admin = requireAdmin(req);
    const body = TestBody.parse(req.body);
    const p = provider(body.providerId);
    const started = Date.now();
    const canEmbed = p.config.kind !== "anthropic";
    const testChat = async () => {
      const r = await tracked(ctx, p, "test", admin.userId, () =>
        p.chat({ system: "You are Barnaby, a friendly raccoon librarian.", messages: [{ role: "user", content: "Say hello in five words or fewer." }], maxTokens: 30 }),
      );
      return { ok: true as const, kind: "chat" as const, model: r.model, reply: r.text, ms: Date.now() - started };
    };
    const testEmbed = async () => {
      const r = await tracked(ctx, p, "test", admin.userId, () => p.embed(["Barnaby the raccoon loves books."]));
      const dimensions = r.vectors[0]?.length ?? 0;
      if (!dimensions) throw new ProviderError(`${p.config.name}: the embeddings reply had no vector`);
      return { ok: true as const, kind: "embeddings" as const, model: r.model, dimensions, ms: Date.now() - started };
    };
    const fail = (e: unknown) => ({ ok: false as const, error: (e as Error).message, ms: Date.now() - started });

    if (body.mode === "chat") return testChat().catch(fail);
    if (body.mode === "embeddings") {
      if (!canEmbed) return fail(new Error(`${p.config.name}: Claude has no embeddings API. Use Ollama, OpenAI or Gemini for meaning search.`));
      return testEmbed().catch(fail);
    }
    if (canEmbed && embeddingsFirst(p.config.id, p.config.model)) {
      try {
        return await testEmbed();
      } catch (e) {
        // Not an embeddings model after all? See if it chats.
        return testChat().catch(() => fail(e));
      }
    }
    try {
      return await testChat();
    } catch (e) {
      // "does not support chat": an embeddings model. Report success if embeddings work.
      if (!canEmbed || !(e instanceof ProviderError) || !e.upstreamStatus || e.upstreamStatus >= 500) return fail(e);
      return testEmbed().catch(() => fail(e));
    }
  });

  /** An embeddings-looking model name, or a provider picked only for meaning search. */
  function embeddingsFirst(id: string, model: string): boolean {
    if (EMBEDDING_MODEL.test(model)) return true;
    const features = getAiSettings(db, ctx.box).features;
    const uses = AI_FEATURES.filter((f) => features[f] === id);
    return uses.length > 0 && uses.every((f) => f === "embeddings");
  }

  app.get<{ Params: { id: string } }>("/api/admin/ai/providers/:id/models", async (req) => {
    requireAdmin(req);
    try {
      return { items: await provider(req.params.id).listModels() };
    } catch (e) {
      if (e instanceof ProviderError) throw httpError(502, e.message);
      throw e;
    }
  });

  app.post("/api/admin/ai/search/test", async (req) => {
    requireAdmin(req);
    const body = SearchTestBody.parse(req.body ?? {});
    const s = getAiSettings(db, ctx.box).search;
    if (!s.enabled || !s.url) throw httpError(400, "Turn on web search and set the SearXNG URL first");
    try {
      return { ok: true, items: await webSearch(ctx.fetchImpl, s, body.q, { kid: body.kid }) };
    } catch (e) {
      return { ok: false, error: (e as Error).message, items: [] };
    }
  });

  app.get("/api/admin/ai/usage", async (req) => {
    requireAdmin(req);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    return usageSummary(ctx, days);
  });

  // ---- Rating helper ---------------------------------------------------------

  // Runs on the job runner as `ai.rating`; progress is also on the admin jobs page.
  /** The last run, plus where the whole library stands, what the rest would cost and what it has cost so far. */
  const ratingView = () => {
    const failed = failedBookIds(ctx, AI_JOB_TYPES.rating);
    return {
      ...batchStatus(ctx, AI_JOB_TYPES.rating),
      progress: ratingProgress(ctx, failed),
      estimate: estimateCost(ctx, "rating"),
      spent: spentOn(ctx, "rating"),
    };
  };

  app.get("/api/admin/ai/rating/run", async (req) => {
    requireAdmin(req);
    return ratingView();
  });

  app.post("/api/admin/ai/rating/run", async (req, reply) => {
    const admin = requireAdmin(req);
    const body = RunBody.parse(req.body ?? {});
    if (!providerFor(getAiSettings(db, ctx.box), "rating")) throw httpError(503, "Pick a provider for the rating helper first");
    const failed = failedBookIds(ctx, AI_JOB_TYPES.rating);
    const ids = body.bookIds?.length
      ? db.select({ id: books.id }).from(books).where(inArray(books.id, body.bookIds)).all().map((b) => b.id)
      : body.retryFailed
        ? ratingCandidates(ctx, EVERYTHING).filter((id) => failed.includes(id))
        : ratingCandidates(ctx, body.all ? EVERYTHING : body.limit, failed);
    if (!ids.length) throw httpError(409, "There's nothing left to rate");
    startBatch(ctx, ctx.runner, AI_JOB_TYPES.rating, ids, `Rating helper: ${ids.length} books`, {
      userId: admin.userId,
      applyStricter: body.applyStricter,
    });
    reply.code(202);
    return ratingView();
  });

  app.get("/api/admin/ai/rating/suggestions", async (req) => {
    requireAdmin(req);
    const q = SuggestionQuery.parse(req.query);
    const rows = db
      .select({ s: aiRatingSuggestions, title: books.title, current: books.rating, currentSource: books.ratingSource, approved: books.approved })
      .from(aiRatingSuggestions)
      .innerJoin(books, eq(books.id, aiRatingSuggestions.bookId))
      .where(and(eq(aiRatingSuggestions.status, q.status), q.scope === "all" ? undefined : eq(books.approved, q.scope === "library")))
      .orderBy(desc(aiRatingSuggestions.createdAt))
      .limit(q.limit)
      .all();
    return {
      items: rows.map((r) => ({ ...r.s, title: r.title, currentRating: r.current, currentSource: r.currentSource, approved: r.approved })),
    };
  });

  /** Take Barnaby's pending rating for many books at once ("Needs a rating" bulk action). */
  app.post("/api/admin/ai/rating/suggestions/accept", async (req) => {
    requireAdmin(req);
    const body = BookIdsBody.parse(req.body);
    return { accepted: acceptRatings(db, body.bookIds) };
  });

  /** Accepting is an admin decision, so the rating is stored as an admin rating. */
  app.post<{ Params: { bookId: string } }>("/api/admin/ai/rating/suggestions/:bookId/accept", async (req) => {
    requireAdmin(req);
    const body = AcceptBody.parse(req.body ?? {});
    const s = db.select().from(aiRatingSuggestions).where(eq(aiRatingSuggestions.bookId, req.params.bookId)).get();
    if (!s) throw httpError(404, "Not found");
    const rating = body.rating ?? s.rating;
    db.update(books).set({ rating, ratingSource: "admin", updatedAt: Date.now() }).where(eq(books.id, s.bookId)).run();
    db.update(aiRatingSuggestions).set({ status: "accepted" }).where(eq(aiRatingSuggestions.bookId, s.bookId)).run();
    return { bookId: s.bookId, rating, ratingSource: "admin" };
  });

  app.post<{ Params: { bookId: string } }>("/api/admin/ai/rating/suggestions/:bookId/dismiss", async (req) => {
    requireAdmin(req);
    const r = db
      .update(aiRatingSuggestions)
      .set({ status: "dismissed" })
      .where(and(eq(aiRatingSuggestions.bookId, req.params.bookId)))
      .run();
    if (!r.changes) throw httpError(404, "Not found");
    return { bookId: req.params.bookId, status: "dismissed" };
  });
}

/** Metadata cleanup and meaning-search indexing (admin-only). */
export async function aiAdminJobRoutes(app: FastifyInstance, ctx: AiContext & { runner: JobRunner }) {
  const { db } = ctx;

  const metadataView = () => {
    const failed = failedBookIds(ctx, AI_JOB_TYPES.metadata);
    return {
      ...batchStatus(ctx, AI_JOB_TYPES.metadata),
      progress: metadataProgress(db, failed),
      estimate: estimateCost(ctx, "metadata"),
      spent: spentOn(ctx, "metadata"),
    };
  };

  app.get("/api/admin/ai/metadata/run", async (req) => {
    requireAdmin(req);
    return metadataView();
  });

  app.post("/api/admin/ai/metadata/run", async (req, reply) => {
    const admin = requireAdmin(req);
    const body = MetadataRunBody.parse(req.body ?? {});
    if (!providerFor(getAiSettings(db, ctx.box), "metadata")) throw httpError(503, "Pick a provider for metadata cleanup first");
    let ids: string[];
    if (body.bookIds?.length) {
      ids = db.select({ id: books.id }).from(books).where(inArray(books.id, body.bookIds)).all().map((b) => b.id);
      // Asked for by name: look again even if checked before.
      if (ids.length) db.delete(aiMetadataChecks).where(inArray(aiMetadataChecks.bookId, ids)).run();
    } else {
      const failed = failedBookIds(ctx, AI_JOB_TYPES.metadata);
      ids = body.retryFailed
        ? metadataCandidates(db, EVERYTHING).filter((id) => failed.includes(id))
        : metadataCandidates(db, body.all ? EVERYTHING : body.limit, failed);
    }
    if (!ids.length) throw httpError(409, "Every book has been checked");
    startBatch(ctx, ctx.runner, AI_JOB_TYPES.metadata, ids, `Metadata cleanup: ${ids.length} books`, { userId: admin.userId });
    reply.code(202);
    return metadataView();
  });

  app.get("/api/admin/ai/metadata/suggestions", async (req) => {
    requireAdmin(req);
    const q = MetadataQuery.parse(req.query);
    return { items: listMetadataSuggestions(db, q.status, q.limit, q.scope) };
  });

  /** Every pending fix for these books (the Inbox's "accept all fixes"). A fix that can't apply is left pending. */
  app.post("/api/admin/ai/metadata/suggestions/accept", async (req) => {
    requireAdmin(req);
    const body = BookIdsBody.parse(req.body);
    const fixes = [...pendingFixes(db, body.bookIds).values()].flat();
    let accepted = 0;
    const skipped: { id: string; error: string }[] = [];
    for (const fix of fixes) {
      try {
        acceptMetadata(db, fix.id);
        accepted++;
      } catch (e) {
        skipped.push({ id: fix.id, error: (e as Error).message });
      }
    }
    if (accepted && providerFor(getAiSettings(db, ctx.box), "embeddings")) queueEmbedding(ctx, ctx.runner, null, body.bookIds);
    return { accepted, skipped };
  });

  app.post<{ Params: { id: string } }>("/api/admin/ai/metadata/suggestions/:id/accept", async (req) => {
    requireAdmin(req);
    const body = MetadataAccept.parse(req.body ?? {});
    const r = acceptMetadata(db, req.params.id, body.value);
    // The book's text changed, so its meaning-search embedding is stale.
    if (providerFor(getAiSettings(db, ctx.box), "embeddings")) queueEmbedding(ctx, ctx.runner, null, [r.bookId]);
    return r;
  });

  app.post<{ Params: { id: string } }>("/api/admin/ai/metadata/suggestions/:id/dismiss", async (req) => {
    requireAdmin(req);
    const r = db.update(aiMetadataSuggestions).set({ status: "dismissed" }).where(eq(aiMetadataSuggestions.id, req.params.id)).run();
    if (!r.changes) throw httpError(404, "Not found");
    return { id: req.params.id, status: "dismissed" };
  });

  app.get("/api/admin/ai/embeddings", async (req) => {
    requireAdmin(req);
    const job = latestEmbedJob();
    return { ...embeddingStatus(ctx), job };
  });

  app.post("/api/admin/ai/embeddings/run", async (req, reply) => {
    const admin = requireAdmin(req);
    const body = EmbedBody.parse(req.body ?? {});
    if (!providerFor(getAiSettings(db, ctx.box), "embeddings")) throw httpError(503, "Pick an embeddings provider first");
    queueEmbedding(ctx, ctx.runner, admin.userId, body.bookIds);
    reply.code(202);
    return { ...embeddingStatus(ctx), job: latestEmbedJob() };
  });

  function latestEmbedJob() {
    const j = latestJob(ctx, AI_JOB_TYPES.embed);
    return j ? { id: j.id, status: j.status, progress: j.progress, result: j.result, lastError: j.lastError, finishedAt: j.finishedAt } : null;
  }
}
