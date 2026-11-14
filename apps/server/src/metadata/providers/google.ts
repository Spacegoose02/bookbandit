/** Google Books. Works without a key at low volume; set GOOGLE_BOOKS_API_KEY for more. */
import type { BookMetadata, ProviderMatch } from "../types.js";
import { toIsbn13 } from "../isbn.js";
import { stripHtml, yearFrom } from "../text.js";
import { getJson, type FetchLike } from "./http.js";
import { plausibleMatch } from "./match.js";

interface Volume {
  id: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    industryIdentifiers?: { type: string; identifier: string }[];
    pageCount?: number;
    categories?: string[];
    maturityRating?: string;
    language?: string;
    imageLinks?: Record<string, string>;
  };
}

export async function searchGoogleBooks(
  fetchFn: FetchLike,
  want: BookMetadata,
  apiKey?: string,
): Promise<ProviderMatch | undefined> {
  let q: string;
  if (want.isbn13) q = `isbn:${want.isbn13}`;
  else if (want.title) q = `intitle:${want.title}${want.authors?.[0] ? ` inauthor:${want.authors[0]}` : ""}`;
  else return undefined;
  const params = new URLSearchParams({ q, maxResults: "5", printType: "books" });
  if (apiKey) params.set("key", apiKey);

  const res = await getJson<{ items?: Volume[] }>(fetchFn, `https://www.googleapis.com/books/v1/volumes?${params}`);
  const items = res?.items ?? [];
  const vol = want.isbn13
    ? items[0]
    : items.find((v) => plausibleMatch(want, { title: v.volumeInfo?.title, authors: v.volumeInfo?.authors }));
  const info = vol?.volumeInfo;
  if (!vol || !info) return undefined;

  const isbn = info.industryIdentifiers
    ?.filter((i) => i.type === "ISBN_13" || i.type === "ISBN_10")
    .map((i) => toIsbn13(i.identifier))
    .find(Boolean);
  const image = info.imageLinks?.extraLarge ?? info.imageLinks?.large ?? info.imageLinks?.medium ?? info.imageLinks?.thumbnail;
  return {
    provider: "google",
    providerId: vol.id,
    title: info.title,
    subtitle: info.subtitle,
    authors: info.authors,
    publisher: info.publisher,
    publishedYear: yearFrom(info.publishedDate),
    description: info.description ? stripHtml(info.description) : undefined,
    isbn13: want.isbn13 ?? isbn,
    pageCount: info.pageCount,
    // Google categories look like "Juvenile Fiction / Animals / Dogs": keep each level.
    subjects: info.categories?.flatMap((c) => c.split("/").map((s) => s.trim())).filter(Boolean),
    language: info.language,
    maturityRating: info.maturityRating === "MATURE" ? "MATURE" : info.maturityRating === "NOT_MATURE" ? "NOT_MATURE" : undefined,
    coverUrl: image?.replace(/^http:/, "https:"),
  };
}
