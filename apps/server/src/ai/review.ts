/**
 * One review flow for new and unrated books.
 *
 * The rating helper and metadata cleanup store suggestions; this file is how the Inbox and the
 * "Needs a rating" page show them next to the book, and how a book Barnaby has looked at moves
 * on by itself:
 *
 * - Filing (`fileRatedBooks`): with `ratingHelper.autoApprove` on (the default), a book in the
 *   Inbox that Barnaby has rated is approved, unless it looks like a copy of a book you already
 *   have. Approval alone never shows a book to a kid: the rating does that (rule 1), and an
 *   unrated book counts as adult.
 * - Ratings: a stricter suggestion is applied at once (rating.ts). A looser one is applied only
 *   when `ratingHelper.trustLooser` is on (off by default), the suggestion is at least
 *   `minConfidence` sure, and the book has no rating of its own yet. Otherwise it waits on the
 *   "Needs a rating" page with Barnaby's pick preselected.
 * - When an admin rates or approves with a rating, the book's pending suggestion is settled, so
 *   the same book never sits in two queues.
 */
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { ratingRank, UNRATED_FALLBACK, type ContentRating } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { books } from "../db/schema.js";
import { aiMetadataSuggestions, aiRatingSuggestions } from "./schema.js";
import type { AiSettings } from "./settings.js";

export interface PendingRating {
  rating: ContentRating;
  confidence: number;
  reasons: string;
}

export interface PendingFix {
  id: string;
  field: string;
  current: unknown;
  suggested: unknown;
  reason: string;
}

/** Barnaby's pending rating per book. */
export function pendingRatings(db: Db, ids: string[]): Map<string, PendingRating> {
  const out = new Map<string, PendingRating>();
  if (!ids.length) return out;
  const rows = db
    .select()
    .from(aiRatingSuggestions)
    .where(and(inArray(aiRatingSuggestions.bookId, ids), eq(aiRatingSuggestions.status, "pending")))
    .all();
  for (const r of rows) out.set(r.bookId, { rating: r.rating, confidence: r.confidence, reasons: r.reasons });
  return out;
}

/** Barnaby's pending metadata fixes per book. */
export function pendingFixes(db: Db, ids: string[]): Map<string, PendingFix[]> {
  const out = new Map<string, PendingFix[]>();
  if (!ids.length) return out;
  const rows = db
    .select()
    .from(aiMetadataSuggestions)
    .where(and(inArray(aiMetadataSuggestions.bookId, ids), eq(aiMetadataSuggestions.status, "pending")))
    .orderBy(aiMetadataSuggestions.field)
    .all();
  for (const r of rows) {
    const fix = { id: r.id, field: r.field, current: r.current, suggested: r.suggested, reason: r.reason };
    out.set(r.bookId, [...(out.get(r.bookId) ?? []), fix]);
  }
  return out;
}

/** SQL: Barnaby has rated this book (any outcome but dismissed). */
export const barnabyRated = sql`exists (select 1 from ${aiRatingSuggestions} where ${aiRatingSuggestions.bookId} = ${books.id} and ${aiRatingSuggestions.status} != 'dismissed')`;
/** SQL: Barnaby has a rating or a fix waiting for this book. */
export const hasPendingSuggestion = sql`(exists (select 1 from ${aiRatingSuggestions} where ${aiRatingSuggestions.bookId} = ${books.id} and ${aiRatingSuggestions.status} = 'pending') or exists (select 1 from ${aiMetadataSuggestions} where ${aiMetadataSuggestions.bookId} = ${books.id} and ${aiMetadataSuggestions.status} = 'pending'))`;
/** SQL: Barnaby has a pending rating for this book. */
export const hasPendingRating = sql`exists (select 1 from ${aiRatingSuggestions} where ${aiRatingSuggestions.bookId} = ${books.id} and ${aiRatingSuggestions.status} = 'pending')`;
/** SQL: Barnaby hasn't looked at this book's rating or details yet. */
export const notSeenByBarnaby = sql`(not exists (select 1 from ${aiRatingSuggestions} where ${aiRatingSuggestions.bookId} = ${books.id}) and not exists (select 1 from ai_metadata_checks c where c.book_id = ${books.id}))`;

/**
 * An admin decided the rating (approve-as, the rating buttons, the book editor): settle the
 * book's pending suggestion, accepted when it matches and dismissed when it doesn't.
 * `rating` null (cleared) dismisses.
 */
export function settleRatings(db: Db, ids: string[], rating: ContentRating | null): void {
  if (!ids.length) return;
  const pending = and(inArray(aiRatingSuggestions.bookId, ids), eq(aiRatingSuggestions.status, "pending"));
  if (rating) db.update(aiRatingSuggestions).set({ status: "accepted" }).where(and(pending, eq(aiRatingSuggestions.rating, rating))).run();
  db.update(aiRatingSuggestions).set({ status: "dismissed" }).where(pending).run();
}

/** Accept Barnaby's pending rating for these books, as an admin rating. Returns how many. */
export function acceptRatings(db: Db, ids: string[]): number {
  const pending = pendingRatings(db, ids);
  if (!pending.size) return 0;
  const now = Date.now();
  db.transaction((tx) => {
    for (const [bookId, s] of pending) {
      tx.update(books).set({ rating: s.rating, ratingSource: "admin", updatedAt: now }).where(eq(books.id, bookId)).run();
      tx.update(aiRatingSuggestions).set({ status: "accepted" }).where(eq(aiRatingSuggestions.bookId, bookId)).run();
    }
  });
  return pending.size;
}

/** Another book with the same ISBN or sort title: an admin should decide whether to merge. */
function hasLikelyCopy(db: Db, b: { id: string; sortTitle: string; isbn13: string | null }): boolean {
  const same = b.isbn13 ? or(eq(books.sortTitle, b.sortTitle), eq(books.isbn13, b.isbn13)) : eq(books.sortTitle, b.sortTitle);
  return !!db.select({ id: books.id }).from(books).where(and(ne(books.id, b.id), same)).limit(1).get();
}

export type RatingHelperSettings = AiSettings["ratingHelper"];

/**
 * Move books Barnaby has rated along: approve them out of the Inbox and, when the admin trusts
 * him with looser ratings, apply the confident ones. `ids` limits it to some books (after a
 * rating); without it the whole library is swept (at start-up, and when the setting changes).
 */
export function fileRatedBooks(db: Db, s: RatingHelperSettings, ids?: string[]): { approved: number; rated: number } {
  const scope = ids ? (ids.length ? inArray(books.id, ids) : sql`0`) : undefined;
  let approved = 0;
  let rated = 0;
  const now = Date.now();
  if (s.trustLooser) {
    const rows = db
      .select({ id: books.id, rating: books.rating, ratingSource: books.ratingSource, s: aiRatingSuggestions })
      .from(aiRatingSuggestions)
      .innerJoin(books, eq(books.id, aiRatingSuggestions.bookId))
      .where(and(eq(aiRatingSuggestions.status, "pending"), scope))
      .all();
    for (const r of rows) {
      // Only books with no rating of their own: a folder, genre or admin rating is never loosened.
      if (r.rating !== null || r.ratingSource === "admin") continue;
      if (r.s.confidence < s.minConfidence) continue;
      if (ratingRank(r.s.rating) > ratingRank(UNRATED_FALLBACK)) continue; // stricter: rating.ts already applied it
      db.transaction((tx) => {
        tx.update(books).set({ rating: r.s.rating, ratingSource: "ai", updatedAt: now }).where(eq(books.id, r.id)).run();
        tx.update(aiRatingSuggestions).set({ status: "applied" }).where(eq(aiRatingSuggestions.bookId, r.id)).run();
      });
      rated++;
    }
  }
  if (s.autoApprove) {
    const inbox = db
      .select({ id: books.id, sortTitle: books.sortTitle, isbn13: books.isbn13 })
      .from(books)
      .where(and(eq(books.approved, false), barnabyRated, scope))
      .all();
    const ok = inbox.filter((b) => !hasLikelyCopy(db, b)).map((b) => b.id);
    for (let i = 0; i < ok.length; i += 500) {
      approved += db.update(books).set({ approved: true, updatedAt: now }).where(inArray(books.id, ok.slice(i, i + 500))).run().changes;
    }
  }
  return { approved, rated };
}
