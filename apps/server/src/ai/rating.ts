/**
 * Rating helper: asks a model to suggest a content rating for books nobody has rated.
 * A suggestion is applied on its own when it's stricter than what the book has now. A looser
 * one waits on the "Needs a rating" page, unless the admin has chosen to trust confident ones
 * (ai/review.ts, which also files rated books out of the Inbox).
 */
import { and, count, eq, inArray, isNull, notExists, notInArray, sql } from "drizzle-orm";
import { CONTENT_RATINGS, ratingRank, UNRATED_FALLBACK, type ContentRating } from "@bookbandit/shared";
import { authors, bookAuthors, bookFiles, books, bookTags, tags } from "../db/schema.js";
import type { AiContext } from "./context.js";
import { openingText } from "./booktext.js";
import { ratingPrompt } from "./prompts.js";
import { makeProvider } from "./providers/index.js";
import { aiRatingSuggestions } from "./schema.js";
import { getAiSettings, providerFor } from "./settings.js";
import { tracked } from "./usage.js";
import { fileRatedBooks } from "./review.js";
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

/** Unrated books Barnaby hasn't suggested anything for yet. */
function unratedUnseen(ctx: AiContext) {
  return and(
    isNull(books.rating),
    eq(books.kindleOnly, false),
    notExists(ctx.db.select({ x: sql`1` }).from(aiRatingSuggestions).where(eq(aiRatingSuggestions.bookId, books.id))),
  );
}

/** Unrated books with no suggestion yet (pending, applied or dismissed), minus `skip` (earlier failures). */
export function ratingCandidates(ctx: AiContext, limit: number, skip: string[] = []): string[] {
  return ctx.db
    .select({ id: books.id })
    .from(books)
    .where(and(unratedUnseen(ctx), skip.length ? notInArray(books.id, skip) : undefined))
    .orderBy(books.addedAt)
    .limit(limit)
    .all()
    .map((r) => r.id);
}

export interface BatchProgress {
  /** Books this tool is about (rating: unrated books; metadata: every book). */
  total: number;
  /** Books Barnaby still has to look at. Zero (and nothing failed) means the tool is done. */
  remaining: number;
  /** Suggestions waiting for an admin to accept or dismiss. */
  waiting: number;
  /** Books that failed and are skipped until someone tries them again. */
  failed: number;
  /** Of `waiting`, the books still in the Inbox (reviewed there; the rest on "Needs a rating"). */
  inInbox?: number;
}

/** Where the rating helper stands over the whole library. `failedIds` from earlier runs. */
export function ratingProgress(ctx: AiContext, failedIds: string[]): BatchProgress {
  const { db } = ctx;
  const n = (where: ReturnType<typeof and>) => db.select({ n: count() }).from(books).where(where).get()?.n ?? 0;
  const unseen = unratedUnseen(ctx);
  const failed = failedIds.length ? n(and(unseen, inArray(books.id, failedIds))) : 0;
  return {
    total: n(and(isNull(books.rating), eq(books.kindleOnly, false))),
    remaining: n(unseen) - failed,
    waiting: db.select({ n: count() }).from(aiRatingSuggestions).where(eq(aiRatingSuggestions.status, "pending")).get()?.n ?? 0,
    inInbox:
      db
        .select({ n: count() })
        .from(aiRatingSuggestions)
        .innerJoin(books, eq(books.id, aiRatingSuggestions.bookId))
        .where(and(eq(aiRatingSuggestions.status, "pending"), eq(books.approved, false)))
        .get()?.n ?? 0,
    failed,
  };
}

/**
 * Rate one book. Applies the suggestion at once only when it's stricter than what the book has
 * now (unrated counts as adult) and the rating isn't an admin's. Returns whether it was applied.
 */
export async function rateBook(ctx: AiContext, bookId: string, applyStricter: boolean, userId: string | null): Promise<{ applied: boolean } | null> {
  const { db } = ctx;
  const settings = getAiSettings(db, ctx.box);
  const config = providerFor(settings, "rating");
  if (!config) throw httpError(503, "Pick a provider for the rating helper first");
  const provider = makeProvider(config, ctx.fetchImpl);
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) return null;
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

  // Re-read: an admin may have rated the book while the model was thinking.
  const fresh = db.select({ rating: books.rating, ratingSource: books.ratingSource }).from(books).where(eq(books.id, bookId)).get();
  if (!fresh) return null;
  const current = fresh.rating ?? UNRATED_FALLBACK;
  const stricter = ratingRank(parsed.rating) > ratingRank(current);
  const apply = applyStricter && fresh.ratingSource !== "admin" && stricter;
  const row = {
    bookId,
    ...parsed,
    providerId: config.id,
    model: r.model,
    // An admin's rating is final, so there's nothing to ask about.
    status: apply ? ("applied" as const) : fresh.ratingSource === "admin" ? ("dismissed" as const) : ("pending" as const),
    createdAt: Date.now(),
  };
  db.insert(aiRatingSuggestions).values(row).onConflictDoUpdate({ target: aiRatingSuggestions.bookId, set: row }).run();
  if (apply) db.update(books).set({ rating: parsed.rating, ratingSource: "ai", updatedAt: Date.now() }).where(eq(books.id, bookId)).run();
  // Out of the Inbox, and a confident looser rating if the admin trusts those (ai/review.ts).
  const filed = fileRatedBooks(db, settings.ratingHelper, [bookId]);
  return { applied: apply || filed.rated > 0 };
}
