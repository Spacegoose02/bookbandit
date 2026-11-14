/**
 * Marks outside Discover books as In library / On Kindle / Request it for one reader.
 * Only books the reader can see (visibleBooksWhere) can be matched, so a locked book shows up
 * as "Request it" (or not at all for kids), never as a hint that it's on the shelf.
 */
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { canSee, UNRATED_FALLBACK, type DiscoverStatus } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, books } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import { matchKey, sortTitle } from "../metadata/text.js";
import type { ExternalBook } from "./sources.js";

export interface DiscoverItem {
  key: string;
  title: string;
  authors: string[];
  year: number | null;
  /** Outside cover; null when the matched library book has its own (use bookId's cover). */
  coverUrl: string | null;
  /** "library" for lists built from the household's own reading. */
  source: ExternalBook["source"] | "library";
  /** The source's page for the book, or the book page for library lists. */
  url: string;
  isbn13: string | null;
  status: DiscoverStatus;
  /** Set when the book is in the library and this reader may open it. */
  bookId: string | null;
  coverPath: string | null;
  /** The household owns it on Kindle (kindle-only entry, or a file book with an ASIN). */
  onKindle: boolean;
  /** Short line under the card: why it's here ("Book 3 of Mistborn", "Caldecott Medal 2024"). */
  note?: string;
  /** Not in the library, and this reader may ask for it (the Request it button). */
  requestable: boolean;
}

interface Candidate {
  id: string;
  title: string;
  isbn13: string | null;
  openLibraryId: string | null;
  hardcoverId: string | null;
  kindleOnly: boolean;
  kindleAsin: string | null;
  coverPath: string | null;
  authorKeys: Set<string>;
}

/**
 * True when outside books are shown at all. Outside lists are unrated, and unrated means adult
 * (CLAUDE.md rule 1), so readers who can't see adult books only get the ones already in their
 * visible library.
 */
export function canSeeOutsideBooks(reader: Reader): boolean {
  return canSee(reader, UNRATED_FALLBACK);
}

export function matchExternal(db: Db, reader: Reader, list: ExternalBook[]): DiscoverItem[] {
  if (!list.length) return [];
  const isbns = [...new Set(list.map((b) => b.isbn13).filter((x): x is string => !!x))];
  const olIds = [...new Set(list.filter((b) => b.source === "openlibrary").map((b) => b.sourceId))];
  const hcIds = [...new Set(list.filter((b) => b.source === "hardcover").map((b) => b.sourceId))];
  const titles = [...new Set(list.map((b) => sortTitle(b.title)))];

  const lowered = [...new Set(list.map((b) => b.title.toLowerCase()))];
  const keys: SQL[] = [inArray(books.sortTitle, titles), inArray(sql`lower(${books.title})`, lowered)];
  if (isbns.length) keys.push(inArray(books.isbn13, isbns));
  if (olIds.length) keys.push(inArray(books.openLibraryId, olIds));
  if (hcIds.length) keys.push(inArray(books.hardcoverId, hcIds));

  const rows = db
    .select({
      id: books.id,
      title: books.title,
      isbn13: books.isbn13,
      openLibraryId: books.openLibraryId,
      hardcoverId: books.hardcoverId,
      kindleOnly: books.kindleOnly,
      kindleAsin: books.kindleAsin,
      coverPath: books.coverPath,
    })
    .from(books)
    .where(and(visibleBooksWhere(reader), or(...keys)))
    .all();

  const authorRows = rows.length
    ? db
        .select({ bookId: bookAuthors.bookId, name: authors.name })
        .from(bookAuthors)
        .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
        .where(inArray(
          bookAuthors.bookId,
          rows.map((r) => r.id),
        ))
        .all()
    : [];
  const candidates: Candidate[] = rows.map((r) => ({
    ...r,
    authorKeys: new Set(authorRows.filter((a) => a.bookId === r.id).map((a) => matchKey(a.name))),
  }));

  const find = (b: ExternalBook): Candidate[] => {
    const exact = candidates.filter(
      (c) =>
        (b.isbn13 && c.isbn13 === b.isbn13) ||
        (b.source === "openlibrary" && c.openLibraryId === b.sourceId) ||
        (b.source === "hardcover" && c.hardcoverId === b.sourceId),
    );
    if (exact.length) return exact;
    // Same title needs an overlapping author too, so "Dune" by someone else isn't a match.
    const title = matchKey(b.title);
    const wanted = b.authors.map(matchKey);
    return candidates.filter(
      (c) => matchKey(c.title) === title && (!wanted.length || !c.authorKeys.size || wanted.some((a) => c.authorKeys.has(a))),
    );
  };

  const out: DiscoverItem[] = [];
  for (const b of list) {
    const hits = find(b);
    // Prefer a readable file over a Kindle-only entry when both exist.
    const best = hits.find((h) => !h.kindleOnly) ?? hits[0];
    // Outside books are unrated (so adult) unless a hand-picked list says who they're for.
    const outsideOk = canSee(reader, b.rating ?? UNRATED_FALLBACK);
    if (!best && !outsideOk) continue;
    const onKindle = hits.some((h) => h.kindleOnly || !!h.kindleAsin);
    out.push({
      key: `${b.source}:${b.sourceId}`,
      title: best?.title ?? b.title,
      authors: b.authors,
      year: b.year,
      coverUrl: best?.coverPath ? null : b.coverUrl,
      source: b.source,
      url: b.url,
      isbn13: b.isbn13,
      status: !best ? "request" : best.kindleOnly ? "kindle" : "library",
      bookId: best?.id ?? null,
      coverPath: best?.coverPath ?? null,
      onKindle,
      ...(b.note ? { note: b.note } : {}),
      requestable: !best && outsideOk,
    });
  }
  return out;
}
