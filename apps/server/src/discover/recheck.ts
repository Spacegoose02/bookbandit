/**
 * Looks up books whose Fiction / Nonfiction is only a guess, so their subjects can settle it.
 *
 * Before taxonomy v2, "Fiction" and "Nonfiction" were dropped before subjects were saved, so a book
 * re-filed from its saved subjects could lose the only clue to which it is. The providers still
 * have it ("Juvenile Nonfiction", "Biography & Autobiography"); this asks them again for just the
 * subjects. Nothing else on the book changes, and books with hand-set categories are skipped.
 */
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, books } from "../db/schema.js";
import { combineMetadata, lookupOnline, type LookupOptions } from "../metadata/lookup.js";
import type { BookMetadata } from "../metadata/types.js";
import { applySubjects, categoriesLocked } from "./category-store.js";

export const RECHECK_JOB = "categories.recheck";
/** Books per job, so a big library shows progress and one job never runs for hours. */
export const RECHECK_BATCH = 100;

export interface RecheckPayload {
  bookIds: string[];
}

export interface RecheckOptions {
  /** Pause between books, to stay friendly with the providers' rate limits. */
  pauseMs?: number;
  signal?: AbortSignal;
  progress?: (fraction: number) => void;
}

/** Returns how many books were looked up. */
export async function recheckKinds(db: Db, bookIds: string[], lookup: LookupOptions, opts: RecheckOptions = {}): Promise<number> {
  let done = 0;
  for (const [i, bookId] of bookIds.entries()) {
    if (opts.signal?.aborted) break;
    if (categoriesLocked(db, [bookId]).size) continue;
    const book = db.select({ title: books.title, isbn13: books.isbn13 }).from(books).where(eq(books.id, bookId)).get();
    if (!book) continue;
    const names = db
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(bookAuthors.bookId, bookId))
      .orderBy(asc(bookAuthors.position))
      .all()
      .map((a) => a.name);
    const known: BookMetadata = { title: book.title, authors: names, isbn13: book.isbn13 ?? undefined };
    const { matches } = await lookupOnline(known, lookup);
    const subjects = combineMetadata(known, matches).subjects;
    if (subjects?.length) db.transaction((tx) => applySubjects(tx, bookId, subjects));
    done++;
    opts.progress?.((i + 1) / bookIds.length);
    if (opts.pauseMs && i < bookIds.length - 1) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }
  return done;
}
