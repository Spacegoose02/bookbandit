/** Online enrichment for one book: fill missing fields, cover, genres, provider ids, and rating. */
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, books, bookSeries } from "../db/schema.js";
import type { BookMetadata } from "../metadata/types.js";
import { combineMetadata, lookupOnline, type LookupOptions } from "../metadata/lookup.js";
import { autoRating, shouldReplaceRating, type RatingSignal } from "../metadata/rating.js";
import { downloadCover, saveCover } from "./covers.js";
import { addGenreTags, bookFieldsFrom, filePathsForBook, fillGaps, lockedFields, setBookAuthors, setBookSeries, withoutLocked } from "./store.js";

export interface EnrichInput {
  db: Db;
  configDir: string;
  bookId: string;
  /** What we know from the file. Omit to search with what's in the database. */
  fileMetadata?: BookMetadata;
  lookup: LookupOptions;
}

export interface EnrichResult {
  providers: string[];
  errors: string[];
  rating: RatingSignal | null;
}

export async function enrichBook(input: EnrichInput): Promise<EnrichResult> {
  const { db, bookId } = input;
  const book = db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book) return { providers: [], errors: ["book not found"], rating: null };

  const currentAuthors = db
    .select({ name: authors.name })
    .from(bookAuthors)
    .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
    .where(eq(bookAuthors.bookId, bookId))
    .orderBy(asc(bookAuthors.position))
    .all()
    .map((a) => a.name);
  const known: BookMetadata = input.fileMetadata ?? {
    title: book.title,
    authors: currentAuthors,
    isbn13: book.isbn13 ?? undefined,
  };

  const { matches, errors } = await lookupOnline(known, input.lookup);
  const combined = combineMetadata(known, matches);
  const maturity = matches.find((m) => m.provider === "google")?.maturityRating;
  const rating = autoRating({ relPaths: filePathsForBook(db, bookId), metadata: combined, maturity });

  const locked = lockedFields(db, bookId);
  db.transaction((tx) => {
    const fields = fillGaps(book, bookFieldsFrom(combined));
    // Title/sortTitle came from the file or the owner; never overwrite them from a provider.
    delete fields.title;
    delete fields.sortTitle;
    for (const m of matches) {
      if (m.provider === "hardcover" && !book.hardcoverId) fields.hardcoverId = m.providerId;
      if (m.provider === "openlibrary" && !book.openLibraryId) fields.openLibraryId = m.providerId;
      if (m.provider === "google" && !book.googleBooksId) fields.googleBooksId = m.providerId;
    }
    if (rating && shouldReplaceRating(book, rating)) {
      fields.rating = rating.rating;
      fields.ratingSource = rating.source;
    }
    // An admin's locked fields stay as they are, even when empty.
    const allowed = withoutLocked(fields, locked);
    if (Object.keys(allowed).length) {
      tx.update(books).set({ ...allowed, updatedAt: Date.now() }).where(eq(books.id, bookId)).run();
    }
    if (!currentAuthors.length && combined.authors?.length && !locked.has("authors")) setBookAuthors(tx, bookId, combined.authors);
    const hasSeries = tx.select().from(bookSeries).where(eq(bookSeries.bookId, bookId)).get();
    if (!hasSeries && combined.series && !locked.has("series")) setBookSeries(tx, bookId, combined.series, combined.seriesPosition);
    addGenreTags(tx, bookId, combined.subjects);
  });

  if (!book.coverPath && !locked.has("cover")) {
    const fetchFn = input.lookup.fetch ?? fetch;
    for (const url of matches.map((m) => m.coverUrl).filter((u): u is string => !!u)) {
      try {
        const cover = await downloadCover(fetchFn, url);
        const coverPath = cover && (await saveCover(input.configDir, bookId, cover));
        if (coverPath) {
          db.update(books).set({ coverPath }).where(eq(books.id, bookId)).run();
          break;
        }
      } catch (err) {
        errors.push(`cover: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { providers: matches.map((m) => m.provider), errors, rating };
}
