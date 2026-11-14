/**
 * Server-side content lock. Every query that returns books to a reader MUST go
 * through `visibleBooksWhere` (or `assertCanSee` for single-book access).
 * Never filter ratings only in the UI.
 */
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { allowedRatings, canSee, UNRATED_FALLBACK, type ContentRating } from "@bookbandit/shared";
import { books } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";

export function visibleBooksWhere(reader: Reader, today: Date = new Date()): SQL | undefined {
  const ratings = allowedRatings(reader, today);
  // Unrated books count as UNRATED_FALLBACK (adult): visible only if that rating is allowed.
  const ratingFilter = ratings.includes(UNRATED_FALLBACK)
    ? or(inArray(books.rating, ratings), isNull(books.rating))
    : inArray(books.rating, ratings);
  // Books waiting in the ingest inbox are admin-only.
  return reader.role === "admin" ? ratingFilter : and(ratingFilter, eq(books.approved, true));
}

export class ContentLockedError extends Error {
  /** 404, not 403: a locked book shouldn't reveal that it exists. */
  statusCode = 404;
  constructor() {
    super("Not found");
  }
}

export function assertCanSee(
  reader: Reader,
  book: { rating: ContentRating | null; approved: boolean },
  today: Date = new Date(),
): void {
  if (reader.role !== "admin" && !book.approved) throw new ContentLockedError();
  if (!canSee(reader, book.rating, today)) throw new ContentLockedError();
}
