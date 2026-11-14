/**
 * OPDS 1.2 catalog at /opds, for KOReader, Moon+ Reader, Thorium, Librera, Panels and friends.
 *
 * Sign-in: an e-reader login over HTTP Basic (see /api/ereader/credentials), or whatever
 * already signs the browser in (Tinyauth header, session, device token).
 *
 * Content lock: every feed, count, author/series/genre list, cover and download goes through
 * `visibleBooksWhere` / `assertCanSee` for the signed-in person. Locked books, and authors,
 * series or genres that only have locked books, answer 404 exactly like ones that don't exist.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z, ZodError } from "zod";
import type { Db } from "../db/client.js";
import { authors, bookAuthors, bookFiles, books, bookSeries, bookTags, kidShelf, readingProgress, series, tags } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere, ContentLockedError } from "../content/lock.js";
import { enrich, likePattern } from "../catalog/list.js";
import { CONTENT_TYPES, downloadName, insideRoot, sendFile } from "../library/serve.js";
import { isDrmProtected } from "../library/drm.js";
import { TooManyAttemptsError } from "../auth/rate-limit.js";
import { basicCredentials, type CredentialStore } from "../ereader/credentials.js";
import { filesByBook, loadVisibleBook, type BookRow, type FileRow } from "../ereader/library.js";
import {
  esc,
  feed,
  iso,
  navEntry,
  openSearchDescription,
  REL_ACQUISITION,
  REL_IMAGE,
  REL_THUMBNAIL,
  ATOM_ACQ,
  ATOM_NAV,
  type Link,
} from "./xml.js";

/** Qualified, for correlated subqueries (drizzle leaves single-table columns unqualified). */
const BOOK_ID = sql.raw(`"books"."id"`);

export const PAGE_SIZE = 50;

/** Formats offered for download, best first. */
const FORMAT_ORDER = ["epub", "kepub", "pdf", "cbz", "cbr", "azw3", "mobi", "fb2", "txt"] as const;

const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

const PageQuery = z.object({ page: z.coerce.number().int().min(1).max(100_000).default(1) });
const SearchQuery = PageQuery.extend({ q: z.string().max(200).default("") });
const IdParams = z.object({ id: z.string().min(1).max(64) });
const FileParams = IdParams.extend({ fileId: z.string().min(1).max(64) });

class AuthChallenge extends Error {
  statusCode = 401;
  constructor() {
    super("Sign in with your Bookbandit e-reader login");
  }
}

export interface OpdsOptions {
  db: Db;
  booksDir: string;
  configDir: string;
  credentials: CredentialStore;
}

export async function opdsRoutes(app: FastifyInstance, opts: OpdsOptions) {
  const { db, credentials } = opts;
  const booksRoot = resolve(opts.booksDir);
  const configRoot = resolve(opts.configDir);

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof AuthChallenge) {
      return reply
        .code(401)
        .header("www-authenticate", 'Basic realm="Bookbandit", charset="UTF-8"')
        .type("text/plain; charset=utf-8")
        .send(err.message);
    }
    if (err instanceof TooManyAttemptsError) {
      return reply.code(429).header("retry-after", Math.ceil(err.retryAfterMs / 1000)).send({ error: err.message });
    }
    if (err instanceof ZodError || err instanceof ContentLockedError) return reply.code(404).send({ error: "Not found" });
    return reply.send(err);
  });

  /** A Basic login wins (it's what the e-reader meant); else the browser's own sign-in. */
  function readerOf(req: FastifyRequest): Reader {
    const basic = basicCredentials(req);
    if (basic) {
      const auth = credentials.verifyLogin(req, basic.username, { password: basic.password });
      if (auth) return auth.reader;
      throw new AuthChallenge();
    }
    if (req.reader) return req.reader;
    throw new AuthChallenge();
  }

  /** Books a reader may see that have at least one file to download. */
  const feedable = (reader: Reader): SQL =>
    and(
      visibleBooksWhere(reader),
      eq(books.kindleOnly, false),
      sql`exists (select 1 from ${bookFiles} where ${bookFiles.bookId} = ${BOOK_ID})`,
    )!;

  function sendXml(reply: FastifyReply, body: string, type = ATOM_ACQ) {
    reply.header("cache-control", "private, no-cache");
    return reply.type(`${type};charset=utf-8`).send(body);
  }

  function pageLinks(base: string, page: number, total: number): Link[] {
    const sep = base.includes("?") ? "&" : "?";
    const at = (p: number) => (p === 1 ? base : `${base}${sep}page=${p}`);
    const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const out: Link[] = [{ rel: "first", href: at(1), type: ATOM_ACQ }];
    if (page > 1) out.push({ rel: "previous", href: at(page - 1), type: ATOM_ACQ });
    if (page < last) out.push({ rel: "next", href: at(page + 1), type: ATOM_ACQ });
    out.push({ rel: "last", href: at(last), type: ATOM_ACQ });
    return out;
  }

  function bookEntry(
    b: BookRow & { authors: { id: string; name: string }[]; series: { id: string; name: string; position: number | null }[] },
    files: FileRow[],
  ): string {
    const parts: string[] = [
      `<title>${esc(b.title)}</title>`,
      `<id>urn:uuid:${esc(b.id)}</id>`,
      `<updated>${iso(b.updatedAt ?? b.addedAt)}</updated>`,
    ];
    for (const a of b.authors) parts.push(`<author><name>${esc(a.name)}</name><uri>/opds/authors/${esc(a.id)}</uri></author>`);
    if (b.language) parts.push(`<dc:language>${esc(b.language)}</dc:language>`);
    if (b.publishedYear) parts.push(`<dc:issued>${b.publishedYear}</dc:issued>`);
    if (b.publisher) parts.push(`<dc:publisher>${esc(b.publisher)}</dc:publisher>`);
    if (b.isbn13) parts.push(`<dc:identifier>urn:isbn:${esc(b.isbn13)}</dc:identifier>`);
    const s = b.series[0];
    const seriesLine = s ? `${s.name}${s.position != null ? ` #${s.position}` : ""}` : "";
    const summary = [seriesLine && `Series: ${seriesLine}`, b.description ?? ""].filter(Boolean).join("\n\n");
    if (summary) parts.push(`<summary type="text">${esc(summary.slice(0, 4000))}</summary>`);
    for (const ser of b.series) {
      parts.push(`<link rel="related" href="/opds/series/${esc(ser.id)}" type="${ATOM_ACQ}" title="${esc(`${ser.name} series`)}"/>`);
    }
    const ext = b.coverPath?.split(".").pop()?.toLowerCase() ?? "";
    if (b.coverPath && IMAGE_TYPES[ext]) {
      parts.push(`<link rel="${REL_IMAGE}" href="/opds/books/${esc(b.id)}/cover" type="${IMAGE_TYPES[ext]}"/>`);
      parts.push(`<link rel="${REL_THUMBNAIL}" href="/opds/books/${esc(b.id)}/cover" type="${IMAGE_TYPES[ext]}"/>`);
    }
    const sorted = [...files].sort(
      (x, y) => FORMAT_ORDER.indexOf(x.format as (typeof FORMAT_ORDER)[number]) - FORMAT_ORDER.indexOf(y.format as (typeof FORMAT_ORDER)[number]),
    );
    for (const f of sorted) {
      parts.push(
        `<link rel="${REL_ACQUISITION}" href="/opds/books/${esc(b.id)}/files/${esc(f.id)}" type="${esc(CONTENT_TYPES[f.format].split(";")[0]!)}" length="${f.sizeBytes}" title="${f.format.toUpperCase()}"/>`,
      );
    }
    return `<entry>${parts.join("")}</entry>`;
  }

  /** One page of an acquisition feed. `narrow` can only shrink what the lock allows. */
  function acquisitionFeed(
    reader: Reader,
    o: { id: string; title: string; self: string; page: number; narrow?: SQL; orderBy: SQL[]; notFoundWhenEmpty?: boolean },
  ): string {
    const where = and(feedable(reader), o.narrow);
    const total = db.select({ n: count() }).from(books).where(where).get()?.n ?? 0;
    if (!total && o.notFoundWhenEmpty) throw new ContentLockedError();
    const rows = db
      .select()
      .from(books)
      .where(where)
      .orderBy(...o.orderBy)
      .limit(PAGE_SIZE)
      .offset((o.page - 1) * PAGE_SIZE)
      .all();
    const enriched = enrich(db, reader, rows);
    const files = filesByBook(db, rows.map((r) => r.id));
    return feed({
      id: o.id,
      title: o.title,
      self: o.page > 1 ? `${o.self}${o.self.includes("?") ? "&" : "?"}page=${o.page}` : o.self,
      kind: "acquisition",
      links: pageLinks(o.self, o.page, total),
      entries: enriched.map((b) => bookEntry(b, files.get(b.id) ?? [])),
      paging: { total, perPage: PAGE_SIZE, startIndex: (o.page - 1) * PAGE_SIZE + 1 },
    });
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  const root = async (req: FastifyRequest, reply: FastifyReply) => {
    const reader = readerOf(req);
    const entries = [
      navEntry({ id: "urn:bookbandit:continue", title: "Continue reading", href: "/opds/continue", content: "Books you've started" }),
      ...(reader.isKid
        ? [navEntry({ id: "urn:bookbandit:kid", title: "My shelf", href: "/opds/kid", content: "Books picked for you" })]
        : []),
      navEntry({ id: "urn:bookbandit:new", title: "Recently added", href: "/opds/new", content: "Newest books first" }),
      navEntry({ id: "urn:bookbandit:all", title: "All books", href: "/opds/books", content: "Everything, by title" }),
      navEntry({ id: "urn:bookbandit:authors", title: "Authors", href: "/opds/authors", kind: "navigation" }),
      navEntry({ id: "urn:bookbandit:series", title: "Series", href: "/opds/series", kind: "navigation" }),
      navEntry({ id: "urn:bookbandit:genres", title: "Genres", href: "/opds/genres", kind: "navigation" }),
    ];
    return sendXml(
      reply,
      feed({ id: "urn:bookbandit:root", title: `Bookbandit: ${reader.displayName}`, self: "/opds", kind: "navigation", entries }),
      ATOM_NAV,
    );
  };
  app.get("/opds", root);
  app.get("/opds/", root);

  app.get("/opds/search.xml", async (req, reply) => {
    readerOf(req);
    return sendXml(reply, openSearchDescription(), "application/opensearchdescription+xml");
  });

  // -------------------------------------------------------------------------
  // Book lists
  // -------------------------------------------------------------------------

  app.get("/opds/books", async (req, reply) => {
    const reader = readerOf(req);
    const { page } = PageQuery.parse(req.query);
    return sendXml(
      reply,
      acquisitionFeed(reader, { id: "urn:bookbandit:all", title: "All books", self: "/opds/books", page, orderBy: [asc(books.sortTitle)] }),
    );
  });

  app.get("/opds/new", async (req, reply) => {
    const reader = readerOf(req);
    const { page } = PageQuery.parse(req.query);
    return sendXml(
      reply,
      acquisitionFeed(reader, {
        id: "urn:bookbandit:new",
        title: "Recently added",
        self: "/opds/new",
        page,
        orderBy: [desc(books.addedAt), asc(books.sortTitle)],
      }),
    );
  });

  app.get("/opds/continue", async (req, reply) => {
    const reader = readerOf(req);
    const { page } = PageQuery.parse(req.query);
    const lastRead = sql`(select ${readingProgress.serverUpdatedAt} from ${readingProgress} where ${readingProgress.bookId} = ${BOOK_ID} and ${readingProgress.userId} = ${reader.userId})`;
    return sendXml(
      reply,
      acquisitionFeed(reader, {
        id: "urn:bookbandit:continue",
        title: "Continue reading",
        self: "/opds/continue",
        page,
        narrow: inArray(
          books.id,
          db
            .select({ id: readingProgress.bookId })
            .from(readingProgress)
            .where(and(eq(readingProgress.userId, reader.userId), eq(readingProgress.finished, false), sql`${readingProgress.percent} > 0`)),
        ),
        orderBy: [desc(lastRead), asc(books.sortTitle)],
      }),
    );
  });

  app.get("/opds/kid", async (req, reply) => {
    const reader = readerOf(req);
    const { page } = PageQuery.parse(req.query);
    return sendXml(
      reply,
      acquisitionFeed(reader, {
        id: "urn:bookbandit:kid",
        title: "My shelf",
        self: "/opds/kid",
        page,
        narrow: inArray(books.id, db.select({ id: kidShelf.bookId }).from(kidShelf).where(eq(kidShelf.kidId, reader.userId))),
        orderBy: [asc(books.sortTitle)],
      }),
    );
  });

  app.get("/opds/search", async (req, reply) => {
    const reader = readerOf(req);
    const { q, page } = SearchQuery.parse(req.query);
    const text = q.trim();
    const pattern = likePattern(text);
    const narrow = text
      ? sql`(${books.title} like ${pattern} escape '\\' or exists (select 1 from ${bookAuthors} join ${authors} on ${authors.id} = ${bookAuthors.authorId} where ${bookAuthors.bookId} = ${BOOK_ID} and ${authors.name} like ${pattern} escape '\\') or exists (select 1 from ${bookSeries} join ${series} on ${series.id} = ${bookSeries.seriesId} where ${bookSeries.bookId} = ${BOOK_ID} and ${series.name} like ${pattern} escape '\\'))`
      : sql`0`;
    return sendXml(
      reply,
      acquisitionFeed(reader, {
        id: `urn:bookbandit:search:${text}`,
        title: text ? `Search: ${text}` : "Search",
        self: `/opds/search?q=${encodeURIComponent(text)}`,
        page,
        narrow,
        orderBy: [asc(books.sortTitle)],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Authors, series, genres (only ones with at least one book the reader may see)
  // -------------------------------------------------------------------------

  function navList(
    reader: Reader,
    o: {
      id: string;
      title: string;
      self: string;
      page: number;
      rows: (limit: number, offset: number) => { id: string; name: string; n: number }[];
      total: number;
      href: (id: string) => string;
    },
  ) {
    const items = o.rows(PAGE_SIZE, (o.page - 1) * PAGE_SIZE);
    return feed({
      id: o.id,
      title: o.title,
      self: o.page > 1 ? `${o.self}?page=${o.page}` : o.self,
      kind: "navigation",
      links: pageLinks(o.self, o.page, o.total).map((l) => ({ ...l, type: ATOM_NAV })),
      entries: items.map((r) =>
        navEntry({ id: `${o.id}:${r.id}`, title: r.name, href: o.href(r.id), content: `${r.n} book${r.n === 1 ? "" : "s"}`, count: r.n }),
      ),
      paging: { total: o.total, perPage: PAGE_SIZE, startIndex: (o.page - 1) * PAGE_SIZE + 1 },
    });
  }

  app.get("/opds/authors", async (req, reply) => {
    const reader = readerOf(req);
    const { page } = PageQuery.parse(req.query);
    const where = and(feedable(reader), eq(bookAuthors.role, "author"));
    const total =
      db
        .select({ n: sql<number>`count(distinct ${authors.id})` })
        .from(authors)
        .innerJoin(bookAuthors, eq(bookAuthors.authorId, authors.id))
        .innerJoin(books, eq(books.id, bookAuthors.bookId))
        .where(where)
        .get()?.n ?? 0;
    return sendXml(
      reply,
      navList(reader, {
        id: "urn:bookbandit:authors",
        title: "Authors",
        self: "/opds/authors",
        page,
        total,
        href: (id) => `/opds/authors/${id}`,
        rows: (limit, offset) =>
          db
            .select({ id: authors.id, name: authors.name, n: sql<number>`count(distinct ${books.id})` })
            .from(authors)
            .innerJoin(bookAuthors, eq(bookAuthors.authorId, authors.id))
            .innerJoin(books, eq(books.id, bookAuthors.bookId))
            .where(where)
            .groupBy(authors.id)
            .orderBy(asc(authors.sortName))
            .limit(limit)
            .offset(offset)
            .all(),
      }),
      ATOM_NAV,
    );
  });

  app.get("/opds/authors/:id", async (req, reply) => {
    const reader = readerOf(req);
    const { id } = IdParams.parse(req.params);
    const { page } = PageQuery.parse(req.query);
    const author = db.select().from(authors).where(eq(authors.id, id)).get();
    if (!author) throw new ContentLockedError();
    return sendXml(
      reply,
      acquisitionFeed(reader, {
        id: `urn:bookbandit:author:${id}`,
        title: author.name,
        self: `/opds/authors/${id}`,
        page,
        narrow: inArray(books.id, db.select({ id: bookAuthors.bookId }).from(bookAuthors).where(eq(bookAuthors.authorId, id))),
        orderBy: [asc(books.publishedYear), asc(books.sortTitle)],
        notFoundWhenEmpty: true,
      }),
    );
  });

  app.get("/opds/series", async (req, reply) => {
    const reader = readerOf(req);
    const { page } = PageQuery.parse(req.query);
    const where = feedable(reader);
    const total =
      db
        .select({ n: sql<number>`count(distinct ${series.id})` })
        .from(series)
        .innerJoin(bookSeries, eq(bookSeries.seriesId, series.id))
        .innerJoin(books, eq(books.id, bookSeries.bookId))
        .where(where)
        .get()?.n ?? 0;
    return sendXml(
      reply,
      navList(reader, {
        id: "urn:bookbandit:series",
        title: "Series",
        self: "/opds/series",
        page,
        total,
        href: (id) => `/opds/series/${id}`,
        rows: (limit, offset) =>
          db
            .select({ id: series.id, name: series.name, n: sql<number>`count(distinct ${books.id})` })
            .from(series)
            .innerJoin(bookSeries, eq(bookSeries.seriesId, series.id))
            .innerJoin(books, eq(books.id, bookSeries.bookId))
            .where(where)
            .groupBy(series.id)
            .orderBy(asc(series.name))
            .limit(limit)
            .offset(offset)
            .all(),
      }),
      ATOM_NAV,
    );
  });

  app.get("/opds/series/:id", async (req, reply) => {
    const reader = readerOf(req);
    const { id } = IdParams.parse(req.params);
    const { page } = PageQuery.parse(req.query);
    const s = db.select().from(series).where(eq(series.id, id)).get();
    if (!s) throw new ContentLockedError();
    const position = sql`(select ${bookSeries.position} from ${bookSeries} where ${bookSeries.bookId} = ${BOOK_ID} and ${bookSeries.seriesId} = ${id})`;
    return sendXml(
      reply,
      acquisitionFeed(reader, {
        id: `urn:bookbandit:series:${id}`,
        title: s.name,
        self: `/opds/series/${id}`,
        page,
        narrow: inArray(books.id, db.select({ id: bookSeries.bookId }).from(bookSeries).where(eq(bookSeries.seriesId, id))),
        orderBy: [sql`${position} is null`, asc(position), asc(books.sortTitle)],
        notFoundWhenEmpty: true,
      }),
    );
  });

  app.get("/opds/genres", async (req, reply) => {
    const reader = readerOf(req);
    const { page } = PageQuery.parse(req.query);
    const where = and(feedable(reader), inArray(tags.kind, ["genre", "section"]));
    const total =
      db
        .select({ n: sql<number>`count(distinct ${tags.id})` })
        .from(tags)
        .innerJoin(bookTags, eq(bookTags.tagId, tags.id))
        .innerJoin(books, eq(books.id, bookTags.bookId))
        .where(where)
        .get()?.n ?? 0;
    return sendXml(
      reply,
      navList(reader, {
        id: "urn:bookbandit:genres",
        title: "Genres",
        self: "/opds/genres",
        page,
        total,
        href: (id) => `/opds/genres/${id}`,
        rows: (limit, offset) =>
          db
            .select({ id: tags.id, name: tags.name, n: sql<number>`count(distinct ${books.id})` })
            .from(tags)
            .innerJoin(bookTags, eq(bookTags.tagId, tags.id))
            .innerJoin(books, eq(books.id, bookTags.bookId))
            .where(where)
            .groupBy(tags.id)
            .orderBy(asc(tags.name))
            .limit(limit)
            .offset(offset)
            .all(),
      }),
      ATOM_NAV,
    );
  });

  app.get("/opds/genres/:id", async (req, reply) => {
    const reader = readerOf(req);
    const { id } = IdParams.parse(req.params);
    const { page } = PageQuery.parse(req.query);
    const tag = db.select().from(tags).where(eq(tags.id, id)).get();
    if (!tag || tag.kind === "custom") throw new ContentLockedError();
    return sendXml(
      reply,
      acquisitionFeed(reader, {
        id: `urn:bookbandit:genre:${id}`,
        title: tag.name,
        self: `/opds/genres/${id}`,
        page,
        narrow: inArray(books.id, db.select({ id: bookTags.bookId }).from(bookTags).where(eq(bookTags.tagId, id))),
        orderBy: [asc(books.sortTitle)],
        notFoundWhenEmpty: true,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Covers and downloads
  // -------------------------------------------------------------------------

  app.get("/opds/books/:id/cover", async (req, reply) => {
    const reader = readerOf(req);
    const { id } = IdParams.parse(req.params);
    const book = loadVisibleBook(db, reader, id);
    const abs = book.coverPath ? insideRoot(configRoot, book.coverPath) : undefined;
    const ext = book.coverPath?.split(".").pop()?.toLowerCase() ?? "";
    const info = abs ? await stat(abs).catch(() => undefined) : undefined;
    if (!abs || !info?.isFile() || !IMAGE_TYPES[ext]) throw new ContentLockedError();
    reply.header("cache-control", "private, max-age=86400");
    reply.header("content-length", info.size);
    reply.type(IMAGE_TYPES[ext]!);
    return reply.send(createReadStream(abs));
  });

  app.get("/opds/books/:id/files/:fileId", async (req, reply) => {
    const reader = readerOf(req);
    const { id, fileId } = FileParams.parse(req.params);
    const book = loadVisibleBook(db, reader, id);
    const file = db
      .select()
      .from(bookFiles)
      .where(and(eq(bookFiles.id, fileId), eq(bookFiles.bookId, book.id)))
      .get();
    const abs = file ? insideRoot(booksRoot, file.relPath) : undefined;
    const info = abs ? await stat(abs).catch(() => undefined) : undefined;
    if (!file || !abs || !info?.isFile()) throw new ContentLockedError();
    if (await isDrmProtected(abs, file.format)) {
      return reply.code(409).send({ error: "This file is DRM-protected and can't be downloaded." });
    }
    // Readers save the file under this name; "attachment" makes browsers download it too.
    return sendFile(reply, abs, info.size, CONTENT_TYPES[file.format], downloadName(book.title, file.format), req.headers.range, "attachment");
  });
}
