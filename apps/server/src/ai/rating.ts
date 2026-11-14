/**
 * Rating helper: asks a model to suggest a content rating for books nobody has rated.
 * Suggestions go to the admin review queue. A suggestion is applied on its own only when
 * it's stricter than what the book has now, so the helper can lock a book but never unlock one.
 */
import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { CONTENT_RATINGS, ratingRank, UNRATED_FALLBACK, type ContentRating } from "@bookbandit/shared";
import { authors, bookAuthors, bookFiles, books, bookTags, tags } from "../db/schema.js";
import type { AiContext } from "./context.js";
import { openingText } from "./booktext.js";
import { ratingPrompt } from "./prompts.js";
import { makeProvider } from "./providers/index.js";
import { aiRatingSuggestions } from "./schema.js";
import { getAiSettings, providerFor } from "./settings.js";
import { tracked } from "./usage.js";
import { httpError } from "../auth/plugin.js";

export interface RatingRunStatus {
  running: boolean;
  total: number;
  done: number;
  suggested: number;
  applied: number;
  failed: number;
  lastError: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export function parseRatingReply(text: string): { rating: ContentRating; confidence: number; reasons: string } | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return null;
  try {
    const o = JSON.parse(json) as { rating?: unknown; confidence?: unknown; reasons?: unknown };
    const rating = String(o.rating ?? "").toLowerCase().replace(/[\s-]+/g, "_") as ContentRating;
    if (!CONTENT_RATINGS.includes(rating)) return null;
    const c = Number(o.confidence);
    return { rating, confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5, reasons: String(o.reasons ?? "").slice(0, 500) };
  } catch {
    return null;
  }
}

/** Unrated books with no open suggestion yet. */
export function ratingCandidates(ctx: AiContext, limit: number): string[] {
  return ctx.db
    .select({ id: books.id })
    .from(books)
    .where(
      and(
        isNull(books.rating),
        eq(books.kindleOnly, false),
        notExists(ctx.db.select({ x: sql`1` }).from(aiRatingSuggestions).where(eq(aiRatingSuggestions.bookId, books.id))),
      ),
    )
    .limit(limit)
    .all()
    .map((r) => r.id);
}

export function createRatingRunner(ctx: AiContext) {
  const status: RatingRunStatus = { running: false, total: 0, done: 0, suggested: 0, applied: 0, failed: 0, lastError: null, startedAt: null, finishedAt: null };

  async function rateOne(bookId: string, applyStricter: boolean, userId: string | null) {
    const { db } = ctx;
    const settings = getAiSettings(db, ctx.box);
    const config = providerFor(settings, "rating");
    if (!config) throw httpError(503, "Pick a provider for the rating helper first");
    const provider = makeProvider(config, ctx.fetchImpl);
    const book = db.select().from(books).where(eq(books.id, bookId)).get();
    if (!book) return;
    const names = db
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(bookAuthors.bookId, bookId))
      .all()
      .map((a) => a.name);
    const genres = db
      .select({ name: tags.name })
      .from(bookTags)
      .innerJoin(tags, eq(tags.id, bookTags.tagId))
      .where(eq(bookTags.bookId, bookId))
      .all()
      .map((t) => t.name);
    const files = db.select({ relPath: bookFiles.relPath, format: bookFiles.format }).from(bookFiles).where(eq(bookFiles.bookId, bookId)).all();
    const opening = await openingText(ctx.booksDir, files, 3000);
    const details = [
      `Title: ${book.title}${book.subtitle ? `: ${book.subtitle}` : ""}`,
      names.length ? `Authors: ${names.join(", ")}` : "",
      book.publisher ? `Publisher: ${book.publisher}` : "",
      book.publishedYear ? `Published: ${book.publishedYear}` : "",
      genres.length ? `Genres: ${genres.join(", ")}` : "",
      files.length ? `Folder: ${files[0]!.relPath.split("/").slice(0, -1).join("/") || "(top level)"}` : "",
      book.description ? `Description: ${book.description.slice(0, 2000)}` : "",
      opening ? `Opening text:\n${opening}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const r = await tracked(ctx, provider, "rating", userId, () =>
      provider.chat({ system: ratingPrompt(), messages: [{ role: "user", content: details }], maxTokens: 200, temperature: 0, json: true }),
    );
    const parsed = parseRatingReply(r.text);
    if (!parsed) throw new Error(`Couldn't read a rating from the model's reply for "${book.title}"`);

    const current = book.rating ?? UNRATED_FALLBACK;
    const stricter = ratingRank(parsed.rating) > ratingRank(current);
    const apply = applyStricter && book.ratingSource !== "admin" && stricter;
    const row = {
      bookId,
      ...parsed,
      providerId: config.id,
      model: r.model,
      status: apply ? ("applied" as const) : ("pending" as const),
      createdAt: Date.now(),
    };
    db.insert(aiRatingSuggestions).values(row).onConflictDoUpdate({ target: aiRatingSuggestions.bookId, set: row }).run();
    if (apply) {
      db.update(books).set({ rating: parsed.rating, ratingSource: "ai", updatedAt: Date.now() }).where(eq(books.id, bookId)).run();
      status.applied++;
    }
    status.suggested++;
  }

  return {
    status: () => ({ ...status }),
    /** Runs in the background; one run at a time. TODO(jobs): move onto the job runner when it lands. */
    start(opts: { bookIds?: string[]; limit: number; applyStricter: boolean; userId: string | null }) {
      if (status.running) throw httpError(409, "The rating helper is already running");
      const settings = getAiSettings(ctx.db, ctx.box);
      if (!providerFor(settings, "rating")) throw httpError(503, "Pick a provider for the rating helper first");
      const ids = opts.bookIds?.length
        ? ctx.db.select({ id: books.id }).from(books).where(inArray(books.id, opts.bookIds)).all().map((b) => b.id)
        : ratingCandidates(ctx, opts.limit);
      Object.assign(status, { running: true, total: ids.length, done: 0, suggested: 0, applied: 0, failed: 0, lastError: null, startedAt: Date.now(), finishedAt: null });
      const done = (async () => {
        for (const id of ids) {
          try {
            await rateOne(id, opts.applyStricter, opts.userId);
          } catch (e) {
            status.failed++;
            status.lastError = (e as Error).message;
          }
          status.done++;
        }
        status.running = false;
        status.finishedAt = Date.now();
      })();
      return done;
    },
  };
}
