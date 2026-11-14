/** Open Library (no key needed). https://openlibrary.org/dev/docs/api/search */
import type { BookMetadata, ProviderMatch } from "../types.js";
import { toIsbn13 } from "../isbn.js";
import { getJson, type FetchLike } from "./http.js";
import { plausibleMatch } from "./match.js";

const BASE = "https://openlibrary.org";
const FIELDS = "key,title,subtitle,author_name,first_publish_year,isbn,subject,cover_i,number_of_pages_median,publisher,language";

interface SearchDoc {
  key: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  isbn?: string[];
  subject?: string[];
  cover_i?: number;
  number_of_pages_median?: number;
  publisher?: string[];
}

export async function searchOpenLibrary(fetchFn: FetchLike, want: BookMetadata): Promise<ProviderMatch | undefined> {
  const params = new URLSearchParams({ fields: FIELDS, limit: "5" });
  if (want.isbn13) params.set("isbn", want.isbn13);
  else if (want.title) {
    params.set("title", want.title);
    if (want.authors?.[0]) params.set("author", want.authors[0]);
  } else return undefined;

  const res = await getJson<{ docs?: SearchDoc[] }>(fetchFn, `${BASE}/search.json?${params}`);
  const docs = res?.docs ?? [];
  const doc = want.isbn13
    ? docs[0]
    : docs.find((d) => plausibleMatch(want, { title: d.title, authors: d.author_name }));
  if (!doc) return undefined;

  const match: ProviderMatch = {
    provider: "openlibrary",
    providerId: doc.key.replace(/^\/works\//, ""),
    title: doc.title,
    subtitle: doc.subtitle,
    authors: doc.author_name,
    publishedYear: doc.first_publish_year,
    isbn13: want.isbn13 ?? doc.isbn?.map((i) => toIsbn13(i)).find(Boolean),
    subjects: doc.subject?.slice(0, 40),
    pageCount: doc.number_of_pages_median,
    publisher: doc.publisher?.[0],
    coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : undefined,
  };

  // The search index has no description; the work record does.
  try {
    const work = await getJson<{ description?: string | { value?: string } }>(fetchFn, `${BASE}${doc.key}.json`);
    const d = work?.description;
    match.description = typeof d === "string" ? d : d?.value;
  } catch {
    // description is optional
  }
  return match;
}
