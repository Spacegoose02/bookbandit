/** Hardcover (GraphQL, needs a personal API token from hardcover.app/account/api). */
import type { BookMetadata, ProviderMatch } from "../types.js";
import { toIsbn13 } from "../isbn.js";
import { getJson, type FetchLike } from "./http.js";
import { plausibleMatch } from "./match.js";

const ENDPOINT = "https://api.hardcover.app/v1/graphql";

interface HardcoverDoc {
  id?: string | number;
  title?: string;
  subtitle?: string;
  author_names?: string[];
  isbns?: string[];
  description?: string;
  release_year?: number;
  pages?: number;
  genres?: string[];
  tags?: string[];
  moods?: string[];
  content_warnings?: string[];
  image?: { url?: string };
  featured_series?: { position?: number; series?: { name?: string } };
  series_names?: string[];
}

export async function searchHardcover(
  fetchFn: FetchLike,
  want: BookMetadata,
  token: string,
): Promise<ProviderMatch | undefined> {
  const query = want.isbn13 ?? [want.title, want.authors?.[0]].filter(Boolean).join(" ");
  if (!query) return undefined;
  const body = JSON.stringify({
    query: `query Search($q: String!) { search(query: $q, query_type: "Book", per_page: 5, page: 1) { results } }`,
    variables: { q: query },
  });
  const res = await getJson<{ data?: { search?: { results?: { hits?: { document?: HardcoverDoc }[] } } } }>(
    fetchFn,
    ENDPOINT,
    {
      method: "POST",
      body,
      headers: { "content-type": "application/json", authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` },
    },
  );
  const docs = (res?.data?.search?.results?.hits ?? []).map((h) => h.document).filter((d): d is HardcoverDoc => !!d);
  const doc = want.isbn13
    ? docs.find((d) => d.isbns?.some((i) => toIsbn13(i) === want.isbn13)) ?? docs[0]
    : docs.find((d) => plausibleMatch(want, { title: d.title, authors: d.author_names }));
  if (!doc || doc.id == null) return undefined;

  const seriesName = doc.featured_series?.series?.name ?? doc.series_names?.[0];
  return {
    provider: "hardcover",
    providerId: String(doc.id),
    title: doc.title,
    subtitle: doc.subtitle,
    authors: doc.author_names,
    description: doc.description,
    publishedYear: doc.release_year,
    pageCount: doc.pages,
    isbn13: want.isbn13 ?? doc.isbns?.map((i) => toIsbn13(i)).find(Boolean),
    subjects: [...(doc.genres ?? []), ...(doc.tags ?? [])],
    contentWarnings: doc.content_warnings,
    series: seriesName,
    seriesPosition: seriesName ? doc.featured_series?.position : undefined,
    coverUrl: doc.image?.url,
  };
}
