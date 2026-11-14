/**
 * "Request a book" search: candidates from Open Library, each with a rating guess and whether
 * the reader already has it in the library.
 *
 * Content lock: "in library" is checked with visibleBooksWhere, so a locked book never shows as
 * owned. Kids only see candidates whose guessed rating is known and within their limit (unknown
 * counts as adult, as everywhere else); they can still type a request by hand for a parent to review.
 */
import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import { canSee, type ContentRating } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { books } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import { autoRating, type RatingSignal } from "../metadata/rating.js";
import { lookupOnline, type LookupOptions } from "../metadata/lookup.js";
import { toIsbn13 } from "../metadata/isbn.js";
import { getJson, type FetchLike } from "../metadata/providers/http.js";
import { sortTitle } from "../metadata/text.js";

export interface Candidate {
  /** Provider reference, e.g. "openlibrary:OL27448W". */
  ref: string;
  title: string;
  author: string | null;
  publishedYear: number | null;
  isbn13: string | null;
  coverUrl: string | null;
  rating: ContentRating | null;
  ratingReason: string | null;
  /** A library book this reader can open already. */
  inLibrary: { id: string } | null;
}

interface OlDoc {
  key: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  isbn?: string[];
  subject?: string[];
  cover_i?: number;
}

const FIELDS = "key,title,author_name,first_publish_year,isbn,subject,cover_i";

export async function searchCandidates(
  db: Db,
  reader: Reader,
  q: string,
  fetchFn: FetchLike,
  today = new Date(),
): Promise<{ items: Candidate[]; hiddenForAge: number }> {
  const isbn = toIsbn13(q.replace(/[\s-]/g, ""));
  const params = new URLSearchParams({ fields: FIELDS, limit: "15" });
  if (isbn) params.set("isbn", isbn);
  else params.set("q", q);
  const res = await getJson<{ docs?: OlDoc[] }>(fetchFn, `https://openlibrary.org/search.json?${params}`);
  const docs = (res?.docs ?? []).filter((d) => d.title);

  const raw = docs.map((d) => {
    const signal = autoRating({ relPaths: [], metadata: { subjects: d.subject ?? [] } });
    return {
      ref: `openlibrary:${d.key.replace(/^\/works\//, "")}`,
      title: d.title!,
      author: d.author_name?.[0] ?? null,
      publishedYear: d.first_publish_year ?? null,
      isbn13: isbn ?? d.isbn?.map((i) => toIsbn13(i)).find((x): x is string => !!x) ?? null,
      coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
      rating: signal?.rating ?? null,
      ratingReason: signal?.reason ?? null,
    };
  });

  const allowed = reader.isKid ? raw.filter((c) => c.rating && canSee(reader, c.rating, today)) : raw;
  const owned = ownedMatches(db, reader, allowed, today);
  const items = allowed.map((c) => ({ ...c, inLibrary: owned(c) }));
  return { items: items.slice(0, 10), hiddenForAge: raw.length - allowed.length };
}

function ownedMatches(db: Db, reader: Reader, cands: { title: string; isbn13: string | null }[], today: Date) {
  if (!cands.length) return () => null;
  const titles = [...new Set(cands.map((c) => sortTitle(c.title)))];
  const isbns = [...new Set(cands.map((c) => c.isbn13).filter((x): x is string => !!x))];
  const match: SQL[] = [inArray(books.sortTitle, titles)];
  if (isbns.length) match.push(inArray(books.isbn13, isbns));
  const rows = db
    .select({ id: books.id, sortTitle: books.sortTitle, isbn13: books.isbn13 })
    .from(books)
    .where(and(visibleBooksWhere(reader, today), eq(books.kindleOnly, false), or(...match)))
    .all();
  return (c: { title: string; isbn13: string | null }) => {
    const hit = rows.find((r) => (c.isbn13 && r.isbn13 === c.isbn13) || r.sortTitle === sortTitle(c.title));
    return hit ? { id: hit.id } : null;
  };
}

/**
 * The server's own rating guess for a request (the client's is never trusted): an online
 * lookup by ISBN or title + author, rated like the library rates files. Null when nothing is known.
 */
export async function guessRating(
  want: { title: string; author: string | null; isbn13: string | null },
  lookup: LookupOptions | false,
): Promise<RatingSignal | null> {
  if (!lookup) return null;
  try {
    const { matches } = await lookupOnline(
      { title: want.title, authors: want.author ? [want.author] : undefined, isbn13: want.isbn13 ?? undefined },
      lookup,
    );
    if (!matches.length) return null;
    const subjects = matches.flatMap((m) => m.subjects ?? []);
    const contentWarnings = matches.flatMap((m) => m.contentWarnings ?? []);
    const maturity = matches.find((m) => m.maturityRating === "MATURE") ? "MATURE" : undefined;
    return autoRating({ relPaths: [], metadata: { subjects, contentWarnings, ageRating: matches.find((m) => m.ageRating)?.ageRating }, maturity });
  } catch {
    return null;
  }
}
