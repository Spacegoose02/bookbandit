/**
 * Outside "what's popular" lists for the Discover page: Open Library trending (no key) and
 * Hardcover trending (needs HARDCOVER_API_TOKEN). Results are cached in memory; matching them
 * against the library happens per reader in match.ts, behind the content lock.
 *
 * Only generic requests go out: no household, user or library details are ever sent.
 */
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
  hardcoverToken?: string;
  now: () => number;
}

const OL = "https://openlibrary.org";

interface OlWork {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  isbn?: string[];
}

async function openLibraryTrending(ctx: SourceContext, period: "daily" | "weekly" | "monthly" | "yearly", limit: number) {
  const res = await getJson<{ works?: OlWork[] }>(ctx.fetch, `${OL}/trending/${period}.json?limit=${limit}`);
  const out: ExternalBook[] = [];
  for (const w of res?.works ?? []) {
    const sourceId = w.key?.replace(/^\/works\//, "");
    const title = w.title && collapse(w.title);
    if (!sourceId || !title) continue;
    out.push({
      source: "openlibrary",
      sourceId,
      title,
      authors: (w.author_name ?? []).map(collapse).filter(Boolean).slice(0, 3),
      year: w.first_publish_year ?? null,
      isbn13: w.isbn?.map((i) => toIsbn13(i)).find((i): i is string => !!i) ?? null,
      coverUrl: w.cover_i ? `https://covers.openlibrary.org/b/id/${w.cover_i}-M.jpg` : null,
      url: `${OL}/works/${sourceId}`,
    });
  }
  return out;
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
  const token = ctx.hardcoverToken!;
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
  const out: ExternalBook[] = [];
  // Keep Hardcover's trending order.
  for (const id of ids) {
    const b = byId.get(String(id));
    const title = b?.title && collapse(b.title);
    if (!b || !title) continue;
    const image = typeof b.cached_image === "string" ? b.cached_image : b.cached_image?.url;
    out.push({
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
    });
  }
  return out;
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
    id: "openlibrary-yearly",
    name: "Popular this year",
    source: "openlibrary",
    load: (ctx, limit) => openLibraryTrending(ctx, "yearly", limit),
  },
];

const OK_TTL = 6 * 60 * 60 * 1000;
const FAIL_TTL = 10 * 60 * 1000;

interface CacheEntry {
  at: number;
  books: ExternalBook[];
  error?: string;
}

/** In-memory cache so Discover doesn't hit outside sites on every page view. */
export class SourceCache {
  private entries = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<CacheEntry>>();

  constructor(private ctx: SourceContext) {}

  available(): ListSpec[] {
    return LISTS.filter((l) => !l.needsHardcover || !!this.ctx.hardcoverToken);
  }

  async get(spec: ListSpec, limit: number): Promise<CacheEntry> {
    const now = this.ctx.now();
    const hit = this.entries.get(spec.id);
    if (hit && now - hit.at < (hit.error ? FAIL_TTL : OK_TTL)) return hit;
    const running = this.inflight.get(spec.id);
    if (running) return running;
    const p = spec
      .load(this.ctx, limit)
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
