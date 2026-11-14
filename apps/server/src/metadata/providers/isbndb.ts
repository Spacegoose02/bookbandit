/**
 * ISBNdb (api2.isbndb.com). Paid, optional: only asked when an admin saves an API key in
 * Admin → Connections, or ISBNDB_API_KEY is set. Strong on ISBNs, publishers and page counts,
 * which helps books the free providers don't know.
 */
import type { BookMetadata, ProviderMatch } from "../types.js";
import { toIsbn13 } from "../isbn.js";
import { stripHtml, yearFrom } from "../text.js";
import { getJson, type FetchLike } from "./http.js";
import { plausibleMatch } from "./match.js";

const BASE = "https://api2.isbndb.com";

export interface IsbndbBook {
  title?: string;
  title_long?: string;
  isbn?: string;
  isbn13?: string;
  publisher?: string;
  language?: string;
  date_published?: string;
  pages?: number;
  authors?: string[];
  subjects?: string[];
  synopsis?: string;
  overview?: string;
  image?: string;
}

/** ISBNdb sends authors as "Sanderson, Brandon" sometimes; keep the reading order. */
function authorName(a: string): string {
  const m = a.match(/^([^,]+),\s*([^,]+)$/);
  return m ? `${m[2]!.trim()} ${m[1]!.trim()}` : a.trim();
}

export function fromIsbndb(b: IsbndbBook, wantIsbn?: string): ProviderMatch | undefined {
  const isbn13 = toIsbn13(b.isbn13) ?? toIsbn13(b.isbn) ?? wantIsbn;
  if (!b.title || !isbn13) return undefined;
  const text = b.synopsis ?? b.overview;
  return {
    provider: "isbndb",
    providerId: isbn13,
    title: b.title,
    authors: b.authors?.map(authorName).filter(Boolean),
    publisher: b.publisher,
    publishedYear: yearFrom(b.date_published),
    description: text ? stripHtml(text) : undefined,
    isbn13,
    pageCount: b.pages && b.pages > 0 ? b.pages : undefined,
    subjects: b.subjects?.filter((s) => s && s.length <= 60),
    language: b.language?.slice(0, 16),
    coverUrl: b.image?.replace(/^http:/, "https:"),
  };
}

export async function searchIsbndb(fetchFn: FetchLike, want: BookMetadata, apiKey: string): Promise<ProviderMatch | undefined> {
  const headers = { authorization: apiKey };
  if (want.isbn13) {
    const res = await getJson<{ book?: IsbndbBook }>(fetchFn, `${BASE}/book/${encodeURIComponent(want.isbn13)}`, { headers });
    return res?.book ? fromIsbndb(res.book, want.isbn13) : undefined;
  }
  if (!want.title) return undefined;
  const q = want.authors?.[0] ? `${want.title} ${want.authors[0]}` : want.title;
  const params = new URLSearchParams({ page: "1", pageSize: "10" });
  const res = await getJson<{ books?: IsbndbBook[] }>(fetchFn, `${BASE}/books/${encodeURIComponent(q)}?${params}`, { headers });
  const hit = (res?.books ?? []).find((b) => plausibleMatch(want, { title: b.title, authors: b.authors?.map(authorName) }));
  return hit ? fromIsbndb(hit) : undefined;
}
