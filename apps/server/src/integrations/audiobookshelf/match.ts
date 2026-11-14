/**
 * Matching Bookbandit books to Audiobookshelf items. Strong keys first (ISBN, ASIN),
 * then normalized title + author surname. Only unambiguous matches are auto-linked.
 */
import type { AbsItemSummary } from "./client.js";

export interface BookForMatch {
  id: string;
  title: string;
  isbn13: string | null;
  kindleAsin: string | null;
  authors: string[];
}

export type MatchReason = "isbn" | "asin" | "title_author";

export interface Match {
  bookId: string;
  absItemId: string;
  reason: MatchReason;
}

export function normalizeIsbn(isbn: string | null | undefined): string | null {
  if (!isbn) return null;
  const digits = isbn.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (digits.length === 13) return digits;
  if (digits.length !== 10) return null;
  // ISBN-10 → ISBN-13
  const core = "978" + digits.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  return core + String((10 - (sum % 10)) % 10);
}

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*[:(\[].*$/, "") // drop subtitles / "(Unabridged)" / "[Book 1]"
    .replace(/^(the|a|an)\s+/, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Last word of each author name, lower-cased ("J.R.R. Tolkien" → "tolkien"). */
export function surnames(names: (string | null | undefined)[]): string[] {
  return names
    .flatMap((n) => (n ?? "").split(/,|&| and /))
    .map((n) => normalizeTitle(n).split(" ").pop() ?? "")
    .filter(Boolean);
}

function uniqueIndex<K>(items: AbsItemSummary[], key: (i: AbsItemSummary) => K | null): Map<K, AbsItemSummary | null> {
  const map = new Map<K, AbsItemSummary | null>();
  for (const item of items) {
    const k = key(item);
    if (k == null) continue;
    map.set(k, map.has(k) ? null : item); // null marks an ambiguous key
  }
  return map;
}

/**
 * Proposes links. Each ABS item is used at most once; ambiguous candidates are skipped.
 */
export function matchBooks(books: BookForMatch[], items: AbsItemSummary[]): Match[] {
  const byIsbn = uniqueIndex(items, (i) => normalizeIsbn(i.isbn));
  const byAsin = uniqueIndex(items, (i) => i.asin?.trim().toUpperCase() || null);
  const byTitle = new Map<string, AbsItemSummary[]>();
  for (const item of items) {
    const t = normalizeTitle(item.title);
    if (!t) continue;
    byTitle.set(t, [...(byTitle.get(t) ?? []), item]);
  }

  const used = new Set<string>();
  const out: Match[] = [];
  const take = (book: BookForMatch, item: AbsItemSummary | null | undefined, reason: MatchReason) => {
    if (!item || used.has(item.id)) return false;
    used.add(item.id);
    out.push({ bookId: book.id, absItemId: item.id, reason });
    return true;
  };

  // Strong keys in a first pass so a title match can't steal an item an ISBN match needs.
  const rest: BookForMatch[] = [];
  for (const book of books) {
    const isbn = normalizeIsbn(book.isbn13);
    const asin = book.kindleAsin?.trim().toUpperCase();
    if (isbn && take(book, byIsbn.get(isbn), "isbn")) continue;
    if (asin && take(book, byAsin.get(asin), "asin")) continue;
    rest.push(book);
  }

  for (const book of rest) {
    const candidates = (byTitle.get(normalizeTitle(book.title)) ?? []).filter((i) => !used.has(i.id));
    const bookSurnames = surnames(book.authors);
    const hits = candidates.filter((i) => {
      if (bookSurnames.length === 0) return false;
      const s = surnames([i.authorName]);
      return s.some((x) => bookSurnames.includes(x));
    });
    if (hits.length === 1) take(book, hits[0], "title_author");
  }
  return out;
}
