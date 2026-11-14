/**
 * "More like this" and the shared helpers for book lists Barnaby returns.
 *
 * Works without any AI provider: books that share a series, an author or genres are found in
 * SQL. When meaning search is set up, the stored embeddings add books with a similar story, and
 * the two lists are merged. Every list starts from `visibleBooksWhere(reader)`.
 */
import { and, eq, exists, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { RATING_MIN_AGE, type ContentRating } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { bookAuthors, books, bookSeries, bookTags } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import { enrich, type BookSummary } from "../catalog/list.js";
import type { AiContext } from "./context.js";
import { bookFacts } from "./book-facts.js";
import { nearestBooks } from "./embeddings.js";

export interface RecommendedBook extends BookSummary {
  /** Short, plain-language reason ("Also by Ada Park", "Also about dragons and magic"). */
  reason: string;
  score: number;
}

/** Books in the given order as BookSummary, re-checked against the lock (and an optional extra filter). */
export function summaries(db: Db, reader: Reader, ids: string[], now: Date, extra?: SQL): BookSummary[] {
  if (!ids.length) return [];
  const rows = db
    .select({
      id: books.id,
      title: books.title,
      publishedYear: books.publishedYear,
      rating: books.rating,
      coverPath: books.coverPath,
      kindleOnly: books.kindleOnly,
    })
    .from(books)
    .where(and(inArray(books.id, ids), visibleBooksWhere(reader, now), extra))
    .all();
  const byId = new Map(enrich(db, reader, rows).map((b) => [b.id, b]));
  return ids.map((id) => byId.get(id)).filter((b): b is BookSummary => !!b);
}

/** Reciprocal rank fusion: robust merge of lists whose scores aren't comparable. */
export function fuse(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  return scores;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * Books like `bookId` that `reader` may open. 404 (ContentLockedError) when the reader can't see
 * the book itself, so a kid can't probe for a locked title through its neighbours.
 */
export function moreLikeThis(ctx: AiContext, reader: Reader, bookId: string, limit = 8, extra?: SQL): RecommendedBook[] {
  const { db } = ctx;
  const now = ctx.now();
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) throw new ContentLockedError();
  assertCanSee(reader, book, now);

  const self = bookFacts(db, [bookId]).get(bookId)!;
  const authorIds = self.authors.map((a) => a.id);
  const tagIds = self.tags.map((t) => t.id);
  const seriesIds = self.series.map((s) => s.id);

  // 1. Shared series, authors or genres, in SQL behind the lock.
  const shares = [
    authorIds.length ? exists(db.select({ x: sql`1` }).from(bookAuthors).where(and(eq(bookAuthors.bookId, books.id), inArray(bookAuthors.authorId, authorIds)))) : undefined,
    tagIds.length ? exists(db.select({ x: sql`1` }).from(bookTags).where(and(eq(bookTags.bookId, books.id), inArray(bookTags.tagId, tagIds)))) : undefined,
    seriesIds.length ? exists(db.select({ x: sql`1` }).from(bookSeries).where(and(eq(bookSeries.bookId, books.id), inArray(bookSeries.seriesId, seriesIds)))) : undefined,
  ].filter((x): x is SQL => !!x);
  const candidates = shares.length
    ? db
        .select({ id: books.id })
        .from(books)
        .where(and(visibleBooksWhere(reader, now), ne(books.id, bookId), or(...shares), extra))
        .limit(400)
        .all()
        .map((r) => r.id)
    : [];
  const facts = bookFacts(db, candidates);
  const metaReason = new Map<string, string>();
  const metaScore = candidates
    .map((id) => {
      const f = facts.get(id)!;
      const sameSeries = f.series.some((s) => seriesIds.includes(s.id));
      const sameAuthors = f.authors.filter((a) => authorIds.includes(a.id));
      const sameTags = f.tags.filter((t) => tagIds.includes(t.id));
      const score = (sameSeries ? 3 : 0) + sameAuthors.length * 2 + Math.min(sameTags.length, 4);
      const reason = sameSeries
        ? `Same series: ${f.series.find((s) => seriesIds.includes(s.id))!.name}`
        : sameAuthors.length
          ? `Also by ${joinWords(sameAuthors.map((a) => a.name))}`
          : `Also about ${joinWords(sameTags.slice(0, 3).map((t) => t.name.toLowerCase()))}`;
      metaReason.set(id, reason);
      return { id, score };
    })
    .sort((a, b) => b.score - a.score);

  // 2. Similar story, from stored embeddings (no model call, so it's instant).
  const near = nearestBooks(ctx, reader, bookId, 30).filter((n) => n.score >= 0.3);
  const nearIds = near.map((n) => n.bookId);

  const fused = fuse([metaScore.map((m) => m.id), nearIds]);
  // Weak genre-only matches shouldn't beat a close story match, and vice versa: RRF handles that.
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id, score]) => ({ id, score }));
  const ids = ranked.map((r) => r.id);
  const scoreOf = new Map(ranked.map((r) => [r.id, r.score]));
  return summaries(db, reader, ids, now, extra)
    .slice(0, limit)
    .map((b) => ({ ...b, reason: metaReason.get(b.id) ?? "A similar story", score: Math.round((scoreOf.get(b.id) ?? 0) * 10000) / 10000 }));
}

/** The highest rating that suits a reader of `age` (never explicit); same thresholds as the content lock. */
export function ratingForAge(age: number): ContentRating {
  if (age >= RATING_MIN_AGE.adult) return "adult";
  if (age >= RATING_MIN_AGE.teen) return "teen";
  if (age >= RATING_MIN_AGE.middle_grade) return "middle_grade";
  return "kids";
}
