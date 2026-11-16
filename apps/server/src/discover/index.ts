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
import type { SecretBox } from "../integrations/secrets.js";
import { requireReader } from "../auth/plugin.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import { enrich, type BookSummary } from "../catalog/list.js";
import type { FetchLike } from "../metadata/providers/http.js";
import { matchKey } from "../metadata/text.js";
import { moreLikeThis } from "../ai/recommend.js";
import { canSeeOutsideBooks, matchExternal, type DiscoverItem } from "./match.js";
import { hardcoverSeries, openLibrarySearch, SourceCache, type ExternalBook, type Loadable, type OlSort, type SeriesEntry } from "./sources.js";
import { AWARD_LISTS } from "./awards.js";
import { authorQuery, DEFAULT_GENRES, GENRE_QUERIES, GENRE_ROW_NAMES, KID_QUERIES, MAX_GENRE_ROWS, subjectQuery } from "./genres.js";
import { allTags, kidRowsFor, MOODS, newArrivals, parentPicks, quickReads, surprise, tagRow, unopened } from "./shelves.js";
import {
  bookSubjects,
  booksByAuthor,
  booksInGenre,
  readingHistory,
  seedBooks,
  seriesInProgress,
  topAuthors,
  topGenres,
  visibleGenres,
} from "./personal.js";
import { seriesRoutes } from "./series.js";
import { categoryRoutes } from "./categories.js";
import type { LookupOptions } from "../metadata/lookup.js";
import { kindleRoutes } from "./kindle.js";

export interface DiscoverOptions {
  db: Db;
  config: Pick<Config, "METADATA_ONLINE" | "HARDCOVER_API_TOKEN">;
  /** For "Because you read": Barnaby's stored embeddings, read through the AI settings. */
  box?: SecretBox;
  /**
   * Current metadata settings (admin settings page, falling back to env vars). False = online
   * lookups are off. Without it, the env config is used.
   */
  resolveLookup?: () => LookupOptions | false;
  /** Test seam for the outside lists. */
  fetchImpl?: FetchLike;
  now?: () => number;
  /** How long one page view waits for outside sites before showing what it has (default 8 s). */
  outsideBudgetMs?: number;
}

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

type ListSource = "openlibrary" | "hardcover" | "library" | "foryou" | "awards";
/** Section a row is shown under on the page. */
type ListGroup = "foryou" | "kids" | "library" | "moods" | "popular" | "genres" | "awards" | "family";

interface DiscoverList {
  id: string;
  name: string;
  source: ListSource;
  group: ListGroup;
  items: DiscoverItem[];
  /** A library book the row is about ("Because you read …" links back to it). */
  aboutBookId?: string;
  /** One line under the row title ("Warm, gentle, low-stakes"). */
  blurb?: string;
  /** Set when the outside site couldn't be reached (the list may be an older copy or empty). */
  error?: string;
}

/** Rows with fewer cards than this (after de-duplication) are left out, except "For you" rows. */
const MIN_ROW = 3;

function libraryItem(b: BookSummary, note?: string): DiscoverItem {
  return {
    key: `library:${b.id}`,
    title: b.title,
    authors: b.authors.map((a) => a.name),
    year: b.publishedYear,
    coverUrl: null,
    source: "library",
    url: `/book/${b.id}`,
    isbn13: null,
    status: b.kindleOnly ? "kindle" : "library",
    bookId: b.id,
    coverPath: b.coverPath,
    onKindle: b.kindleOnly,
    ...(note ? { note } : {}),
    requestable: false,
  };
}

/** Row id from a name: "Mystery & Crime" → "mystery-crime". */
function slugId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Same book across rows: the library id when matched, else title plus first author. */
function dedupeKeys(i: DiscoverItem): string[] {
  // Same title by a different author is a different book ("Happy Hippo" vs "The Happy Hippo" by someone else).
  const keys = [`t:${matchKey(i.title)}|${matchKey(i.authors[0] ?? "")}`];
  if (i.bookId) keys.push(`b:${i.bookId}`);
  if (i.isbn13) keys.push(`i:${i.isbn13}`);
  return keys;
}

/** Resolves to undefined when `p` takes longer than `ms`; the cache keeps filling in the background. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
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

/** "Book 3 of Mistborn", or just the series name for an unnumbered book. */
function seriesNote(position: number | null, name: string): string {
  return position == null ? name : `Book ${position} of ${name}`;
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

  const search = (id: string, q: string, sort: OlSort = "trending"): Loadable => ({
    id,
    load: (ctx, limit) => openLibrarySearch(ctx, q, limit, sort),
  });
  const aiCtx = opts.box
    ? {
        db,
        box: opts.box,
        fetchImpl: opts.fetchImpl ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init)),
        booksDir: "",
        now: () => new Date((opts.now ?? Date.now)()),
      }
    : null;
  const budget = opts.outsideBudgetMs ?? 8000;

  app.get("/api/discover", async (req) => {
    const reader = requireReader(req);
    const q = Query.parse(req.query);
    const online = lookup() !== false;
    const outsideOk = canSeeOutsideBooks(reader);
    const hardcover = online && cache.hasHardcover();

    const history = readingHistory(db, reader);
    const started = new Set(history.map((h) => h.id));
    const historyIds = history.map((h) => h.id);

    /** Fetches an outside list (cached), or [] if offline, failing, or slower than the budget. */
    const outside = async (spec: Loadable, size = 40): Promise<{ books: ExternalBook[]; error?: string }> => {
      if (!online) return { books: [] };
      const entry = await within(cache.get(spec, size), budget);
      return entry ?? { books: [], error: "timed out" };
    };
    const match = (list: ExternalBook[]) => matchExternal(db, reader, list).filter((i) => !i.bookId || !started.has(i.bookId));

    // Every outside lookup this page needs starts at once; rows are put together in order below.
    // ---- For you -------------------------------------------------------------------------------
    const seriesRows = seriesInProgress(db, reader, history, started, 4);
    const seriesOutside = seriesRows.map((s) =>
      hardcover
        ? outside({ id: `hc-series:${s.name.toLowerCase()}`, ttl: 24 * 3600_000, load: (ctx) => hardcoverSeries(ctx, s.name) }, 50)
        : Promise.resolve({ books: [] as ExternalBook[] }),
    );

    const seeds = seedBooks(history, 2);
    const seedInfo = seeds.map((sd) => ({ ...sd, ...bookSubjects(db, sd.id) }));
    const seedOutside = seedInfo.map((sd) => {
      const query = subjectQuery(sd.subjects) ?? sd.genres.map((g) => GENRE_QUERIES[g]).find(Boolean);
      return outsideOk && query ? outside(search(`like:${query}`, query, "readinglog")) : Promise.resolve({ books: [] as ExternalBook[] });
    });

    const authorNames = topAuthors(db, historyIds, 2);
    const authorOutside = authorNames.map((name) =>
      outsideOk ? outside(search(`author:${name.toLowerCase()}`, authorQuery(name), "readinglog")) : Promise.resolve({ books: [] as ExternalBook[] }),
    );

    // ---- Popular, genres and awards ----------------------------------------------------------
    const popular = online ? cache.available() : [];
    const popularP = popular.map((spec) => outside(spec));

    const liked = topGenres(db, historyIds);
    const genreNames = outsideOk
      ? [...new Set([...liked, ...DEFAULT_GENRES])].filter((g) => GENRE_QUERIES[g]).slice(0, MAX_GENRE_ROWS)
      : [];
    const genreP = genreNames.map((g) => outside(search(`genre:${g}`, GENRE_QUERIES[g]!)));

    const awards = reader.isKid || !outsideOk ? AWARD_LISTS.filter((a) => a.kids) : AWARD_LISTS;
    const awardsP = awards.map((a) => outside(a));

    // For the kids: grown-ups (who see outside books) also get popular kids' books from Open Library.
    const kidQueries = outsideOk ? KID_QUERIES : [];
    const kidQueriesP = kidQueries.map((k) => outside(search(k.id, k.q, "readinglog")));

    const lists: DiscoverList[] = [];
    const seen = new Set<string>();
    /**
     * Adds a row, dropping books an earlier row already showed. `free` rows (the mood tabs, which
     * are alternatives to each other) neither claim books nor lose them to other rows.
     */
    const add = (list: Omit<DiscoverList, "items">, items: DiscoverItem[], min = MIN_ROW, free = false) => {
      const fresh: DiscoverItem[] = [];
      for (const i of items) {
        if (fresh.length >= q.limit) break;
        const keys = dedupeKeys(i);
        if (!free && keys.some((k) => seen.has(k))) continue;
        if (!free) keys.forEach((k) => seen.add(k));
        fresh.push(i);
      }
      if (fresh.length >= min || (list.error && !fresh.length && outsideOk)) lists.push({ ...list, items: fresh });
    };

    // Next in your series: library books first, then the ones the library is missing.
    const seriesItems: DiscoverItem[] = [];
    const seriesExt = await Promise.all(seriesOutside);
    seriesRows.forEach((s, i) => {
      const own = s.next.slice(0, 2).map((b) => libraryItem(b, seriesNote(b.position, s.name)));
      seriesItems.push(...own);
      // Hardcover knows the whole series: the next books the library doesn't have yet.
      const missing = (seriesExt[i]?.books ?? [])
        .map((b) => ({ ...b, position: (b as Partial<SeriesEntry>).position ?? 0 }))
        .filter((b) => b.position > s.reached)
        .map((b) => ({ ...b, note: seriesNote(b.position, s.name) }));
      seriesItems.push(...match(missing).filter((m) => !m.bookId).slice(0, 2));
    });
    add({ id: "series-next", name: "Next in your series", source: "foryou", group: "foryou" }, seriesItems, 1);

    // Parent picks: a kid's "Parent approved" books (their own and their family's) lead their page.
    const now = (opts.now ?? Date.now)();
    const picks = parentPicks(db, reader, started, q.limit + 10).map((b) => libraryItem(b));
    if (reader.isKid) add({ id: "parent-picks", name: "Picked by your grown-ups", source: "library", group: "foryou" }, picks, 1);

    // Because you read …: Barnaby's "more like this" from the library, then similar books elsewhere.
    const seedExt = await Promise.all(seedOutside);
    const authorExt = await Promise.all(authorOutside);
    const rows: { list: Omit<DiscoverList, "items">; items: DiscoverItem[] }[] = [];
    seedInfo.forEach((sd, i) => {
      const own = aiCtx
        ? moreLikeThis(aiCtx, reader, sd.id, 12)
            .filter((b) => !started.has(b.id))
            .map((b) => libraryItem(b, b.reason))
        : [];
      const sameAuthor = new Set(sd.authors.map(matchKey));
      const ext = match(seedExt[i]?.books ?? []).filter((m) => !m.authors.some((a) => sameAuthor.has(matchKey(a))));
      rows.push({
        list: { id: `because-${sd.id}`, name: `Because you read ${sd.title}`, source: "foryou", group: "foryou", aboutBookId: sd.id },
        items: [...own.slice(0, 8), ...ext],
      });
    });
    authorNames.forEach((name, i) => {
      const own = booksByAuthor(db, reader, name, started, 10).map((b) => libraryItem(b));
      rows.push({
        list: { id: `author-${slugId(name)}`, name: `More by ${name}`, source: "foryou", group: "foryou" },
        items: [...own, ...match(authorExt[i]?.books ?? [])],
      });
    });
    // Interleave so one seed doesn't push every author row down the page.
    for (const r of rows) add(r.list, r.items, 1);

    // Library rows. Grown-ups' outside rows claim books first, so trending keeps its "In library"
    // badges; a kid's own age bands and themes come before everything else.
    const tagList = allTags(db);
    const shelfRows = () => {
      // Parent picks first: a parent chose these on purpose.
      if (!reader.isKid)
        add({ id: "parent-picks", name: "Parent picks for the family", source: "library", group: "library" }, picks, 1);
      // Kids' age bands and themes, from the library. For a kid these are their own rows; grown-ups
      // see them under "For the kids", limited to kids' ratings.
      for (const row of kidRowsFor(reader))
        add(
          { id: row.id, name: reader.isKid ? (row.kidName ?? row.name) : row.name, source: "library", group: "kids" },
          tagRow(db, reader, row, started, q.limit + 10, now, tagList).map((b) => libraryItem(b)),
          reader.isKid ? 1 : 2,
        );

      // From the family's shelves: new arrivals, books nobody has opened, quick reads.
      add(
        { id: "new-arrivals", name: "New in the library", source: "library", group: "library" },
        newArrivals(db, reader, started, q.limit + 10).map((b) => libraryItem(b)),
        1,
      );
      add(
        { id: "unopened", name: reader.isKid ? "Nobody has read these yet" : "Waiting on the shelf", blurb: "Nobody in the house has opened these yet", source: "library", group: "library" },
        unopened(db, reader, started, q.limit + 10, now).map((b) => libraryItem(b)),
        2,
      );
      add(
        { id: "quick-reads", name: "Quick reads", blurb: "Under 200 pages", source: "library", group: "library" },
        quickReads(db, reader, started, q.limit + 10, now).map((b) => libraryItem(b)),
        2,
      );
    };
    if (reader.isKid) shelfRows();

    // Moods: shown as tabs, so each can repeat books from other rows.
    for (const m of MOODS)
      add(
        { id: m.id, name: m.name, blurb: m.blurb, source: "library", group: "moods" },
        tagRow(db, reader, m, started, q.limit, now, tagList).map((b) => libraryItem(b)),
        1,
        true,
      );

    // What's popular: Hardcover and Open Library trending, and new books.
    const popularExt = await Promise.all(popularP);
    popular.forEach((spec, i) => {
      const e = popularExt[i]!;
      add(
        { id: spec.id, name: spec.name, source: spec.source, group: "popular", ...(e.error ? { error: e.error } : {}) },
        match(e.books),
        1,
      );
    });

    // Genres: the reader's favourites first. Kids get rows from the library only, behind the lock.
    if (outsideOk) {
      const genreExt = await Promise.all(genreP);
      genreNames.forEach((g, i) =>
        add(
          { id: `genre-${slugId(g)}`, name: GENRE_ROW_NAMES[g] ?? g, source: "openlibrary", group: "genres" },
          match(genreExt[i]?.books ?? []),
        ),
      );
    } else {
      const kidGenres = [...new Set([...liked, ...visibleGenres(db, reader, 8)])].slice(0, 6);
      for (const g of kidGenres)
        add(
          { id: `genre-${slugId(g)}`, name: GENRE_ROW_NAMES[g] ?? g, source: "library", group: "genres" },
          booksInGenre(db, reader, g, started, 24).map((b) => libraryItem(b)),
          1,
        );
    }

    // Popular kids' books from Open Library, for grown-ups choosing for their kids.
    const kidExt = await Promise.all(kidQueriesP);
    kidQueries.forEach((k, i) => add({ id: k.id, name: k.name, source: "openlibrary", group: "kids" }, match(kidExt[i]?.books ?? [])));

    // Prize winners. Kids' prizes carry their audience rating, so kids see the ones meant for them.
    const awardExt = await Promise.all(awardsP);
    awards.forEach((a, i) => add({ id: a.id, name: a.name, source: "awards", group: "awards" }, match(awardExt[i]?.books ?? [])));

    if (!reader.isKid) shelfRows();

    // The household's own favourites go last, after what the wider world is reading.
    const family = popularInFamily(db, reader, q.limit + 10);
    add(
      { id: "family", name: "Popular in your family", source: "library", group: "family" },
      family.map((b) => libraryItem(b)),
      1,
      // What the household is reading is worth showing even if a row above already has it.
      true,
    );

    return { lists, online, requests: outsideOk };
  });

  // "Surprise me": one random book this reader may open and hasn't started.
  const SurpriseQuery = z.object({
    kids: z.enum(["1", "true"]).optional(),
    mood: z.string().max(40).optional(),
  });
  app.get("/api/discover/surprise", async (req, reply) => {
    const reader = requireReader(req);
    const sq = SurpriseQuery.parse(req.query);
    const book = surprise(db, reader, { kidsOnly: !!sq.kids, ...(sq.mood ? { mood: sq.mood } : {}) });
    if (!book) return reply.code(404).send({ error: "not_found", message: "Nothing left to surprise you with." });
    return { book };
  });

  await app.register(seriesRoutes, { db });
  // Fiction / Nonfiction re-checks look books up online, with the same settings as enrichment.
  await app.register(categoryRoutes, {
    db,
    resolveLookup: () => {
      const l = lookup();
      return l ? { ...l, ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}) } : false;
    },
  });
  await app.register(kindleRoutes, { db });
}
