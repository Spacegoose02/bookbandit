/**
 * Discover, series, categories and Kindle library import (workstream 11).
 * Everything that returns books goes through visibleBooksWhere / assertCanSee.
 */
import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { books, readingProgress, users } from "../db/schema.js";
import { requireReader } from "../auth/plugin.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import { enrich, type BookSummary } from "../catalog/list.js";
import type { FetchLike } from "../metadata/providers/http.js";
import { canSeeOutsideBooks, matchExternal, type DiscoverItem } from "./match.js";
import { SourceCache } from "./sources.js";
import { seriesRoutes } from "./series.js";
import { categoryRoutes } from "./categories.js";
import { kindleRoutes } from "./kindle.js";

export interface DiscoverOptions {
  db: Db;
  config: Pick<Config, "METADATA_ONLINE" | "HARDCOVER_API_TOKEN">;
  /**
   * Current metadata settings (admin settings page, falling back to env vars). False = online
   * lookups are off. Without it, the env config is used.
   */
  resolveLookup?: () => { hardcoverToken?: string } | false;
  /** Test seam for the outside lists. */
  fetchImpl?: FetchLike;
  now?: () => number;
}

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

interface DiscoverList {
  id: string;
  name: string;
  source: "openlibrary" | "hardcover" | "library";
  items: DiscoverItem[];
  /** Set when the outside site couldn't be reached (the list may be an older copy or empty). */
  error?: string;
}

/** Books most people in the household have opened, newest activity breaking ties. */
function popularInFamily(db: Db, reader: Reader, limit: number): BookSummary[] {
  const readers = count(readingProgress.userId);
  const rows = db
    .select({
      id: books.id,
      title: books.title,
      publishedYear: books.publishedYear,
      rating: books.rating,
      coverPath: books.coverPath,
      kindleOnly: books.kindleOnly,
      readers,
    })
    .from(readingProgress)
    .innerJoin(books, eq(books.id, readingProgress.bookId))
    .innerJoin(users, eq(users.id, readingProgress.userId))
    .where(and(visibleBooksWhere(reader), eq(users.householdId, reader.householdId), gt(readingProgress.percent, 0)))
    .groupBy(books.id)
    .orderBy(desc(readers), desc(readingProgress.serverUpdatedAt))
    .limit(limit)
    .all();
  return enrich(
    db,
    reader,
    rows.map(({ readers: _r, ...b }) => b),
  );
}

export async function discoverPlugin(app: FastifyInstance, opts: DiscoverOptions) {
  const { db, config } = opts;
  const lookup = () =>
    opts.resolveLookup ? opts.resolveLookup() : config.METADATA_ONLINE ? { hardcoverToken: config.HARDCOVER_API_TOKEN } : false;
  const cache = new SourceCache({
    fetch: opts.fetchImpl ?? ((input, init) => fetch(input, init)),
    hardcoverToken: () => {
      const l = lookup();
      return l ? l.hardcoverToken : undefined;
    },
    now: opts.now ?? Date.now,
  });

  app.get("/api/discover", async (req) => {
    const reader = requireReader(req);
    const q = Query.parse(req.query);
    const lists: DiscoverList[] = [];

    const online = lookup() !== false;
    if (online) {
      const specs = cache.available();
      const entries = await Promise.all(specs.map((s) => cache.get(s, 40)));
      specs.forEach((spec, i) => {
        const entry = entries[i]!;
        const items = matchExternal(db, reader, entry.books).slice(0, q.limit);
        // Kids only see the books already on their side of the lock; skip lists with none.
        if (!items.length && !canSeeOutsideBooks(reader)) return;
        lists.push({
          id: spec.id,
          name: spec.name,
          source: spec.source,
          items,
          ...(entry.error ? { error: entry.error } : {}),
        });
      });
    }

    // The household's own favourites go last, after what the wider world is reading.
    const family = popularInFamily(db, reader, q.limit);
    if (family.length)
      lists.push({
        id: "family",
        name: "Popular in your family",
        source: "library",
        items: family.map((b) => ({
          key: `library:${b.id}`,
          title: b.title,
          authors: b.authors.map((a) => a.name),
          year: b.publishedYear,
          coverUrl: null,
          source: "library" as const,
          url: `/book/${b.id}`,
          isbn13: null,
          status: b.kindleOnly ? ("kindle" as const) : ("library" as const),
          bookId: b.id,
          coverPath: b.coverPath,
          onKindle: b.kindleOnly,
        })),
      });

    return { lists, online, requests: canSeeOutsideBooks(reader) };
  });

  await app.register(seriesRoutes, { db });
  await app.register(categoryRoutes, { db });
  await app.register(kindleRoutes, { db });
}
