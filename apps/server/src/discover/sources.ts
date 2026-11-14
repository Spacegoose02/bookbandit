/**
 * Outside "what's popular" lists for the Discover page: Open Library trending (no key) and
 * Hardcover trending (needs HARDCOVER_API_TOKEN). Results are cached in memory; matching them
 * against the library happens per reader in match.ts, behind the content lock.
 *
 * Only generic requests go out: no household, user or library details are ever sent.
 */
import type { ContentRating } from "@bookbandit/shared";
import { getJson, type FetchLike } from "../metadata/providers/http.js";
import { toIsbn13 } from "../metadata/isbn.js";
import { collapse } from "../metadata/text.js";

/** One book from an outside list, before it is matched against the library. */
export interface ExternalBook {
  source: "openlibrary" | "hardcover";
  /** The source's own id: an Open Library work id (OL123W) or a Hardcover book id. */
  sourceId: string;
  title: string;
  authors: string[];
  year: number | null;
  isbn13: string | null;
  coverUrl: string | null;
  /** Page about the book on the source's site. */
  url: string;
  /** Short line under the card ("Book 3 of Mistborn", "Newbery Medal 2024"). */
  note?: string;
  /**
   * Set only for hand-picked lists whose audience we know (award lists). Everything else is
   * unrated, and unrated means adult (CLAUDE.md rule 1).
   */
  rating?: ContentRating;
}

export interface ListSpec {
  id: string;
  name: string;
  source: ExternalBook["source"];
  /** Needs a Hardcover token. */
  needsHardcover?: boolean;
  load: (ctx: SourceContext, limit: number) => Promise<ExternalBook[]>;
}

export interface SourceContext {
  fetch: FetchLike;
  /** Read on every use, so a token saved in the admin settings applies without a restart. */
  hardcoverToken: () => string | undefined;
  now: () => number;
}

const OL = "https://openlibrary.org";

interface OlEdition {
  key?: string;
  title?: string;
  cover_i?: number;
  language?: string[];
  isbn?: string[];
}

interface OlWork {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  isbn?: string[];
  language?: string[];
  /** With `lang=en`, Open Library puts the best English edition first. */
  editions?: { docs?: OlEdition[] };
}

/** Search fields: the work plus its best edition for `lang=en`, so covers and titles come out in English. */
const OL_FIELDS = "key,title,author_name,first_publish_year,cover_i,isbn,language,editions,editions.key,editions.title,editions.cover_i,editions.language,editions.isbn";

const isEnglish = (langs: string[] | undefined) => !langs?.length || langs.includes("eng");

function fromOlWork(w: OlWork): ExternalBook | null {
  const sourceId = w.key?.replace(/^\/works\//, "");
  if (!sourceId) return null;
  // An English edition beats the work's default cover, which is sometimes a translation
  // (a French "Comment se faire des amis" cover for How to Win Friends).
  const english = w.editions?.docs?.find((e) => e.language?.includes("eng"));
  const title = collapse(w.title ?? english?.title ?? "");
  if (!title) return null;
  const cover = english?.cover_i ?? w.cover_i;
  const isbns = [...(english?.isbn ?? []), ...(w.isbn ?? [])];
  return {
    source: "openlibrary",
    sourceId,
    title,
    authors: (w.author_name ?? []).map(collapse).filter(Boolean).slice(0, 3),
    year: w.first_publish_year ?? null,
    isbn13: isbns.map((i) => toIsbn13(i)).find((i): i is string => !!i) ?? null,
    coverUrl: cover ? `https://covers.openlibrary.org/b/id/${cover}-M.jpg` : null,
    url: `${OL}/works/${sourceId}`,
  };
}

/** Books with no English edition at all are left out: the family reads in English. */
function olBooks(works: OlWork[] | undefined): ExternalBook[] {
  return (works ?? []).filter((w) => isEnglish(w.language)).map(fromOlWork).filter((b): b is ExternalBook => !!b);
}

/**
 * Open Library's trending endpoint picks one cover per work, sometimes a translated edition's.
 * Look the same works up once more through search with `lang=en` and take the English cover and
 * ISBN where there is one. A failure here keeps the original list.
 */
async function preferEnglish(ctx: SourceContext, list: ExternalBook[]): Promise<ExternalBook[]> {
  const keys = list.filter((b) => b.source === "openlibrary").map((b) => `/works/${b.sourceId}`);
  if (!keys.length) return list;
  try {
    const q = `key:(${keys.map((k) => `"${k}"`).join(" OR ")})`;
    const res = await getJson<{ docs?: OlWork[] }>(
      ctx.fetch,
      `${OL}/search.json?${new URLSearchParams({ q, lang: "en", fields: OL_FIELDS, limit: String(keys.length) })}`,
    );
    const better = new Map(olBooks(res?.docs).map((b) => [b.sourceId, b]));
    const known = new Set((res?.docs ?? []).map((d) => d.key?.replace(/^\/works\//, "")));
    return list
      // Drop works search knows about but that have no English edition.
      .filter((b) => !known.has(b.sourceId) || better.has(b.sourceId))
      .map((b) => {
        const e = better.get(b.sourceId);
        return e ? { ...b, coverUrl: e.coverUrl ?? b.coverUrl, isbn13: e.isbn13 ?? b.isbn13 } : b;
      });
  } catch {
    return list;
  }
}

async function openLibraryTrending(ctx: SourceContext, period: "daily" | "weekly" | "monthly" | "yearly", limit: number) {
  const res = await getJson<{ works?: OlWork[] }>(ctx.fetch, `${OL}/trending/${period}.json?limit=${limit}`);
  return preferEnglish(ctx, olBooks(res?.works));
}

export type OlSort = "trending" | "readinglog" | "rating" | "want_to_read";

/**
 * Open Library work search, English editions only. `q` uses Open Library's search syntax
 * (`subject:fantasy`, `author:"Ursula K. Le Guin"`). Falls back to the reading-log sort if the
 * server doesn't know the requested one.
 */
export async function openLibrarySearch(
  ctx: SourceContext,
  q: string,
  limit: number,
  sort: OlSort = "trending",
  extra: Record<string, string> = {},
): Promise<ExternalBook[]> {
  const url = (s: OlSort) =>
    `${OL}/search.json?${new URLSearchParams({ q: `${q} language:eng`, sort: s, lang: "en", fields: OL_FIELDS, limit: String(limit), ...extra })}`;
  let res: { docs?: OlWork[] } | undefined;
  try {
    res = await getJson(ctx.fetch, url(sort));
  } catch (e) {
    if (sort === "readinglog") throw e;
    res = await getJson(ctx.fetch, url("readinglog"));
  }
  return olBooks(res?.docs);
}

/** One title by one author, for hand-picked lists: the closest English edition, or null. */
export async function openLibraryFind(ctx: SourceContext, title: string, author: string): Promise<ExternalBook | null> {
  const res = await getJson<{ docs?: OlWork[] }>(
    ctx.fetch,
    `${OL}/search.json?${new URLSearchParams({ title, author, lang: "en", fields: OL_FIELDS, limit: "3" })}`,
  );
  return olBooks(res?.docs)[0] ?? null;
}

const HARDCOVER = "https://api.hardcover.app/v1/graphql";

interface HardcoverBook {
  id?: number | string;
  title?: string;
  slug?: string;
  release_year?: number | null;
  cached_image?: { url?: string } | string | null;
  cached_contributors?: { author?: { name?: string } }[] | null;
  default_physical_edition?: { isbn_13?: string | null } | null;
}

async function hardcoverQuery<T>(ctx: SourceContext, query: string, variables: Record<string, unknown>): Promise<T | undefined> {
  const token = ctx.hardcoverToken()!;
  const res = await getJson<{ data?: T; errors?: { message?: string }[] }>(ctx.fetch, HARDCOVER, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
    headers: { "content-type": "application/json", authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` },
  });
  if (res?.errors?.length) throw new Error(`hardcover: ${res.errors[0]?.message ?? "query failed"}`);
  return res?.data;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function fromHardcover(b: HardcoverBook): ExternalBook | null {
  const title = b.title && collapse(b.title);
  if (!title || b.id == null) return null;
  const image = typeof b.cached_image === "string" ? b.cached_image : b.cached_image?.url;
  return {
    source: "hardcover",
    sourceId: String(b.id),
    title,
    authors: (b.cached_contributors ?? [])
      .map((c) => c.author?.name)
      .filter((n): n is string => !!n)
      .map(collapse)
      .slice(0, 3),
    year: b.release_year ?? null,
    isbn13: (b.default_physical_edition?.isbn_13 && toIsbn13(b.default_physical_edition.isbn_13)) || null,
    coverUrl: image ?? null,
    url: b.slug ? `https://hardcover.app/books/${b.slug}` : "https://hardcover.app/trending",
  };
}

export interface SeriesEntry extends ExternalBook {
  position: number;
}

/**
 * The books of a series on Hardcover, one per position, in reading order. Needs a token; returns
 * [] when the series isn't found. Used for "Next in your series" to find books the library lacks.
 */
export async function hardcoverSeries(ctx: SourceContext, name: string): Promise<SeriesEntry[]> {
  const data = await hardcoverQuery<{
    series?: { book_series?: { position?: number | null; book?: HardcoverBook | null }[] }[];
  }>(
    ctx,
    `query Series($name: String!) { series(where: { name: { _eq: $name } }, order_by: { books_count: desc }, limit: 1) { book_series(order_by: { position: asc }) { position book { id title slug release_year cached_image cached_contributors default_physical_edition { isbn_13 } } } } }`,
    { name },
  );
  const out: SeriesEntry[] = [];
  const seen = new Set<number>();
  for (const bs of data?.series?.[0]?.book_series ?? []) {
    const pos = bs.position;
    // Whole-number positions only: skips novellas (1.5) and duplicate editions at the same spot.
    if (pos == null || !Number.isInteger(pos) || pos < 1 || seen.has(pos) || !bs.book) continue;
    const b = fromHardcover(bs.book);
    if (!b) continue;
    seen.add(pos);
    out.push({ ...b, position: pos });
  }
  return out;
}

/** Hardcover's trending list: the most-shelved books over the last month. */
async function hardcoverTrending(ctx: SourceContext, limit: number): Promise<ExternalBook[]> {
  const to = ctx.now();
  const from = to - 30 * 86_400_000;
  const trending = await hardcoverQuery<{ books_trending?: { ids?: number[] } }>(
    ctx,
    `query Trending($from: date!, $to: date!, $limit: Int!) { books_trending(from: $from, to: $to, limit: $limit, offset: 0) { ids } }`,
    { from: day(from), to: day(to), limit },
  );
  const ids = trending?.books_trending?.ids ?? [];
  if (!ids.length) return [];
  const data = await hardcoverQuery<{ books?: HardcoverBook[] }>(
    ctx,
    `query Books($ids: [Int!]) { books(where: { id: { _in: $ids } }) { id title slug release_year cached_image cached_contributors default_physical_edition { isbn_13 } } }`,
    { ids },
  );
  const byId = new Map((data?.books ?? []).map((b) => [String(b.id), b]));
  // Keep Hardcover's trending order.
  return ids
    .map((id) => byId.get(String(id)))
    .map((b) => (b ? fromHardcover(b) : null))
    .filter((b): b is ExternalBook => !!b);
}

export const LISTS: ListSpec[] = [
  {
    id: "hardcover-trending",
    name: "Trending on Hardcover",
    source: "hardcover",
    needsHardcover: true,
    load: hardcoverTrending,
  },
  {
    id: "openlibrary-weekly",
    name: "Trending this week",
    source: "openlibrary",
    load: (ctx, limit) => openLibraryTrending(ctx, "weekly", limit),
  },
  {
    // Open Library's yearly trending list was nearly the same as the weekly one, so the second
    // row is books first published this year or last that people are reading now.
    id: "openlibrary-new",
    name: "New and noteworthy",
    source: "openlibrary",
    load: (ctx, limit) => {
      const year = new Date(ctx.now()).getUTCFullYear();
      return openLibrarySearch(ctx, `first_publish_year:[${year - 1} TO ${year}]`, limit, "trending");
    },
  },
];

const OK_TTL = 6 * 60 * 60 * 1000;
const FAIL_TTL = 10 * 60 * 1000;
/** Outside requests in flight at once, so a cold Discover page doesn't flood Open Library. */
const MAX_PARALLEL = 4;

interface CacheEntry {
  at: number;
  books: ExternalBook[];
  error?: string;
}

/** A cacheable outside lookup: fixed lists above, or ones built per page (genres, authors, series). */
export interface Loadable {
  id: string;
  /** How long a good answer is kept (default 6 hours). */
  ttl?: number;
  load: (ctx: SourceContext, limit: number) => Promise<ExternalBook[]>;
}

/** In-memory cache so Discover doesn't hit outside sites on every page view. */
export class SourceCache {
  private entries = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<CacheEntry>>();
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(private ctx: SourceContext) {}

  get context(): SourceContext {
    return this.ctx;
  }

  available(): ListSpec[] {
    return LISTS.filter((l) => !l.needsHardcover || !!this.ctx.hardcoverToken());
  }

  hasHardcover(): boolean {
    return !!this.ctx.hardcoverToken();
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_PARALLEL) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  async get(spec: Loadable, limit: number): Promise<CacheEntry> {
    const now = this.ctx.now();
    const hit = this.entries.get(spec.id);
    if (hit && now - hit.at < (hit.error ? FAIL_TTL : (spec.ttl ?? OK_TTL))) return hit;
    const running = this.inflight.get(spec.id);
    if (running) return running;
    const p = this.slot(() => spec.load(this.ctx, limit))
      .then(
        (books): CacheEntry => ({ at: now, books }),
        // Keep showing the last good list if a refresh fails.
        (e: unknown): CacheEntry => ({
          at: now,
          books: hit?.books ?? [],
          error: e instanceof Error ? e.message : String(e),
        }),
      )
      .then((entry) => {
        this.entries.set(spec.id, entry);
        this.inflight.delete(spec.id);
        return entry;
      });
    this.inflight.set(spec.id, p);
    return p;
  }
}
