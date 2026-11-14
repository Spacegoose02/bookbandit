import { CONTENT_RATINGS, ratingRank, type ContentRating } from "@bookbandit/shared";

/**
 * Library filters. They narrow what the server already allowed; they never widen it.
 * The content lock lives on the server (`visibleBooksWhere`), so an "age group" pick
 * here can only hide more books, never show locked ones.
 */
export interface LibraryFilters {
  q: string;
  /** Author id (what the API filters on) */
  author: string;
  /** Author's name, only for showing in the filter box */
  authorName: string;
  yearFrom: number | null;
  yearTo: number | null;
  /** Empty = all ratings the reader is allowed */
  ratings: ContentRating[];
  /** Restrict to one shelf/section (series id, collection id, "kid", ...) */
  shelf: string;
  sort: SortKey;
}

export const SORT_KEYS = ["title", "author", "year", "added"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const EMPTY_FILTERS: LibraryFilters = {
  q: "",
  author: "",
  authorName: "",
  yearFrom: null,
  yearTo: null,
  ratings: [],
  shelf: "",
  sort: "title",
};

/** Friendly age-group names for the filter chips. */
export const AGE_GROUP_LABELS: Record<ContentRating, string> = {
  kids: "Little kids (0 to 7)",
  middle_grade: "Kids (8 to 12)",
  teen: "Teens (13+)",
  adult: "Grown-ups",
  explicit: "Explicit",
};

/** Age groups worth offering to this reader: the ones at or below their limit. */
export function ageGroupOptions(maxRating: ContentRating): ContentRating[] {
  return CONTENT_RATINGS.filter((r) => ratingRank(r) <= ratingRank(maxRating));
}

const MIN_YEAR = 0;
const MAX_YEAR = 9999;

function parseYear(raw: string | null): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_YEAR || n > MAX_YEAR) return null;
  return n;
}

/** Read filters from a URL query string, dropping anything malformed. */
export function filtersFromSearch(params: URLSearchParams): LibraryFilters {
  let yearFrom = parseYear(params.get("yearFrom"));
  let yearTo = parseYear(params.get("yearTo"));
  if (yearFrom != null && yearTo != null && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom];

  const ratings = (params.get("ratings") ?? "")
    .split(",")
    .filter((r): r is ContentRating => (CONTENT_RATINGS as readonly string[]).includes(r));
  const sortRaw = params.get("sort") ?? "";
  const sort = (SORT_KEYS as readonly string[]).includes(sortRaw) ? (sortRaw as SortKey) : "title";

  return {
    q: params.get("q")?.trim() ?? "",
    author: params.get("author")?.trim() ?? "",
    authorName: params.get("authorName")?.trim() ?? "",
    yearFrom,
    yearTo,
    ratings: [...new Set(ratings)],
    shelf: params.get("shelf")?.trim() ?? "",
    sort,
  };
}

/** Write filters back into a query string. Default values are left out to keep URLs short. */
export function filtersToSearch(f: LibraryFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.author) p.set("author", f.author);
  if (f.author && f.authorName) p.set("authorName", f.authorName);
  if (f.yearFrom != null) p.set("yearFrom", String(f.yearFrom));
  if (f.yearTo != null) p.set("yearTo", String(f.yearTo));
  if (f.ratings.length) p.set("ratings", f.ratings.join(","));
  if (f.shelf) p.set("shelf", f.shelf);
  if (f.sort !== "title") p.set("sort", f.sort);
  return p;
}

/**
 * Query params for GET /api/books. Ratings above the reader's limit are dropped
 * here as a courtesy; the server ignores them anyway.
 */
export function filtersToApiQuery(
  f: LibraryFilters,
  maxRating: ContentRating,
  page: { limit: number; offset: number },
): URLSearchParams {
  const p = filtersToSearch({ ...f, ratings: f.ratings.filter((r) => ratingRank(r) <= ratingRank(maxRating)) });
  p.delete("authorName");
  p.set("limit", String(page.limit));
  p.set("offset", String(page.offset));
  return p;
}

export function activeFilterCount(f: LibraryFilters): number {
  return (
    (f.q ? 1 : 0) +
    (f.author ? 1 : 0) +
    (f.yearFrom != null || f.yearTo != null ? 1 : 0) +
    (f.ratings.length ? 1 : 0)
  );
}
