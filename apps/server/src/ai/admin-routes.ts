/** Admin-only Barnaby settings, provider tests, usage and the rating helper (CLAUDE.md rule 4). */
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { CONTENT_RATINGS } from "@bookbandit/shared";
import { books } from "../db/schema.js";
import { httpError, requireAdmin } from "../auth/plugin.js";
import type { AiContext } from "./context.js";
import { makeProvider, ProviderError } from "./providers/index.js";
import { createRatingRunner } from "./rating.js";
import { aiRatingSuggestions } from "./schema.js";
import { webSearch } from "./search.js";
import { AiSettingsInput, getAiSettings, publicAiSettings, saveAiSettings } from "./settings.js";
import { tracked, usageSummary } from "./usage.js";

const TestBody = z.object({ providerId: z.string().min(1) });
const SearchTestBody = z.object({ q: z.string().trim().min(1).max(300).default("dinosaurs"), kid: z.boolean().default(false) });
const RunBody = z.object({
  bookIds: z.array(z.string().min(1)).max(500).optional(),
  limit: z.number().int().min(1).max(500).default(25),
  applyStricter: z.boolean().default(true),
});
const SuggestionQuery = z.object({
  status: z.enum(["pending", "accepted", "applied", "dismissed"]).default("pending"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const AcceptBody = z.object({ rating: z.enum(CONTENT_RATINGS).optional() });

export async function aiAdminRoutes(app: FastifyInstance, ctx: AiContext & { runner: ReturnType<typeof createRatingRunner> }) {
  const { db } = ctx;

  app.get("/api/admin/ai/settings", async (req) => {
    requireAdmin(req);
    return publicAiSettings(getAiSettings(db, ctx.box));
  });

  app.put("/api/admin/ai/settings", async (req) => {
    requireAdmin(req);
    AiSettingsInput.parse(req.body); // 400 with zod details before touching anything
    return publicAiSettings(saveAiSettings(db, ctx.box, req.body));
  });

  function provider(id: string) {
    const config = getAiSettings(db, ctx.box).providers.find((p) => p.id === id);
    if (!config) throw httpError(404, "No provider with that id");
    return makeProvider(config, ctx.fetchImpl);
  }

  /** Sends a tiny prompt and reports the answer and how long it took. Save settings first. */
  app.post("/api/admin/ai/providers/test", async (req) => {
    const admin = requireAdmin(req);
    const p = provider(TestBody.parse(req.body).providerId);
    const started = Date.now();
    try {
      const r = await tracked(ctx, p, "test", admin.userId, () =>
        p.chat({ system: "You are Barnaby, a friendly raccoon librarian.", messages: [{ role: "user", content: "Say hello in five words or fewer." }], maxTokens: 30 }),
      );
      return { ok: true, model: r.model, reply: r.text, ms: Date.now() - started };
    } catch (e) {
      return { ok: false, error: (e as Error).message, ms: Date.now() - started };
    }
  });

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

  app.get("/api/admin/ai/rating/run", async (req) => {
    requireAdmin(req);
    return ctx.runner.status();
  });

  app.post("/api/admin/ai/rating/run", async (req, reply) => {
    const admin = requireAdmin(req);
    const body = RunBody.parse(req.body ?? {});
    void ctx.runner.start({ ...body, userId: admin.userId });
    reply.code(202);
    return ctx.runner.status();
  });

  app.get("/api/admin/ai/rating/suggestions", async (req) => {
    requireAdmin(req);
    const q = SuggestionQuery.parse(req.query);
    const rows = db
      .select({ s: aiRatingSuggestions, title: books.title, current: books.rating, currentSource: books.ratingSource, approved: books.approved })
      .from(aiRatingSuggestions)
      .innerJoin(books, eq(books.id, aiRatingSuggestions.bookId))
      .where(eq(aiRatingSuggestions.status, q.status))
      .orderBy(desc(aiRatingSuggestions.createdAt))
      .limit(q.limit)
      .all();
    return {
      items: rows.map((r) => ({ ...r.s, title: r.title, currentRating: r.current, currentSource: r.currentSource, approved: r.approved })),
    };
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
