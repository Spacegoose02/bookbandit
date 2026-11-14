/** Book request API. See requests/README.md. */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { canSee } from "@bookbandit/shared";
import { toReader } from "../auth/reader.js";
import type { Db } from "../db/client.js";
import { bookRequests, users } from "../db/schema.js";
import { httpError, requireAdmin, requireReader } from "../auth/plugin.js";
import { visibleBooksWhere } from "../content/lock.js";
import type { LookupOptions } from "../metadata/lookup.js";
import type { FetchLike } from "../metadata/providers/http.js";
import { toIsbn13 } from "../metadata/isbn.js";
import { parse } from "./validate.js";
import {
  approvableWhere,
  findDuplicate,
  findVisibleBook,
  initialStatus,
  loadVisibleRequest,
  MAX_OPEN_REQUESTS,
  openRequestCount,
  requestViews,
  setRequest,
  type RequestRow,
} from "./service.js";
import { guessRating, searchCandidates } from "./search.js";

const REQUEST_STATUSES = ["pending", "approved", "declined", "downloading", "done", "failed"] as const;

const SearchQuery = z.object({ q: z.string().trim().min(2).max(200) });
const ListQuery = z.object({
  /** mine: my own. approvals: ones I can approve. all: everyone's (admin). */
  scope: z.enum(["mine", "approvals", "all"]).default("mine"),
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",") : undefined))
    .pipe(z.array(z.enum(REQUEST_STATUSES)).optional()),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const CreateBody = z.object({
  title: z.string().trim().min(1).max(300),
  author: z.string().trim().max(200).nullish(),
  isbn13: z.string().trim().max(20).nullish(),
  coverUrl: z
    .string()
    .url()
    .max(500)
    .refine((u) => /^https:\/\//i.test(u), "must be https")
    .nullish(),
  publishedYear: z.number().int().min(0).max(3000).nullish(),
  /** A message to whoever approves it. */
  note: z.string().trim().max(500).nullish(),
});
const IdParams = z.object({ id: z.string().min(1).max(64) });
const DecideBody = z.object({ note: z.string().trim().max(500).nullish() }).default({});
const DownloadBody = z
  .object({
    via: z.enum(["auto", "shelfmark", "sabnzbd", "direct"]).default("auto"),
    /** direct: the file URL; sabnzbd: an NZB URL. */
    url: z
      .string()
      .url()
      .max(2000)
      .refine((u) => /^https?:\/\//i.test(u), "must be http(s)")
      .optional(),
  })
  .default({});

export interface RequestRouteOptions {
  db: Db;
  fetchImpl: FetchLike;
  /** Online lookup for the server's rating guess; false when online lookup is off. */
  resolveLookup: () => LookupOptions | false;
  /** Starts the download for an approved request when auto-download is on and a downloader is set up. */
  startDownload: (row: RequestRow, opts: { via: "auto" | "shelfmark" | "sabnzbd" | "direct"; url?: string; auto: boolean }) => string | null;
}

export async function requestRoutes(app: FastifyInstance, opts: RequestRouteOptions) {
  const { db } = opts;

  app.get("/api/requests/search", async (req) => {
    const reader = requireReader(req);
    const { q } = parse(SearchQuery, req.query);
    try {
      return await searchCandidates(db, reader, q, opts.fetchImpl);
    } catch (err) {
      req.log.warn({ err }, "request search failed");
      throw httpError(502, "Book search is unavailable right now. You can still type the title.");
    }
  });

  app.get("/api/requests", async (req) => {
    const reader = requireReader(req);
    const q = parse(ListQuery, req.query);
    let scope: SQL | undefined;
    if (q.scope === "mine") scope = eq(bookRequests.requestedBy, reader.userId);
    else if (q.scope === "approvals") scope = approvableWhere(db, reader);
    else {
      requireAdmin(req);
      scope = eq(users.householdId, reader.householdId);
    }
    const where = and(scope, q.status ? inArray(bookRequests.status, q.status) : undefined);
    const rows = db
      .select({ r: bookRequests })
      .from(bookRequests)
      .innerJoin(users, eq(users.id, bookRequests.requestedBy))
      .where(where)
      .orderBy(desc(bookRequests.createdAt))
      .limit(q.limit)
      .offset(q.offset)
      .all()
      .map((x) => x.r);
    const total =
      db
        .select({ n: sql<number>`count(*)` })
        .from(bookRequests)
        .innerJoin(users, eq(users.id, bookRequests.requestedBy))
        .where(where)
        .get()?.n ?? 0;
    return { items: requestViews(db, reader, rows), total, limit: q.limit, offset: q.offset };
  });

  /** Badge counts for the nav: my open requests and how many wait for my approval. */
  app.get("/api/requests/summary", async (req) => {
    const reader = requireReader(req);
    const toApprove =
      reader.role === "admin" || reader.role === "parent"
        ? (db
            .select({ n: sql<number>`count(*)` })
            .from(bookRequests)
            .innerJoin(users, eq(users.id, bookRequests.requestedBy))
            .where(and(approvableWhere(db, reader), eq(bookRequests.status, "pending")))
            .get()?.n ?? 0)
        : 0;
    return { open: openRequestCount(db, reader.userId), toApprove };
  });

  app.post("/api/requests", async (req, reply) => {
    const reader = requireReader(req);
    const body = parse(CreateBody, req.body);
    const isbn13 = toIsbn13(body.isbn13 ?? undefined) ?? null;
    const author = body.author || null;

    const owned = findVisibleBook(db, reader, body.title, isbn13, visibleBooksWhere(reader));
    if (owned) {
      reply.code(409);
      return { error: "already_in_library", message: "That book is already in the library.", book: owned };
    }
    const dup = findDuplicate(db, reader.userId, body.title, isbn13);
    if (dup) {
      reply.code(200);
      return { request: requestViews(db, reader, [dup])[0], duplicate: true };
    }
    if (openRequestCount(db, reader.userId) >= MAX_OPEN_REQUESTS) {
      throw httpError(429, `You already have ${MAX_OPEN_REQUESTS} open requests. Wait for some to finish first.`);
    }

    // The server's own guess; the client can't lower it.
    const guess = await guessRating({ title: body.title, author, isbn13 }, opts.resolveLookup());
    const start = initialStatus(reader, guess?.rating ?? null);
    const now = Date.now();
    const [row] = db
      .insert(bookRequests)
      .values({
        requestedBy: reader.userId,
        title: body.title,
        author,
        isbn13,
        coverUrl: body.coverUrl ?? null,
        publishedYear: body.publishedYear ?? null,
        rating: guess?.rating ?? null,
        ratingReason: guess?.reason ?? null,
        status: start.status,
        note: start.note ?? body.note ?? null,
        decidedBy: start.status === "approved" ? reader.userId : null,
        decidedAt: start.status === "pending" ? null : now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();
    if (row!.status === "approved") opts.startDownload(row!, { via: "auto", auto: true });
    reply.code(201);
    const fresh = db.select().from(bookRequests).where(eq(bookRequests.id, row!.id)).get()!;
    return { request: requestViews(db, reader, [fresh])[0], duplicate: false };
  });

  app.get("/api/requests/:id", async (req) => {
    const reader = requireReader(req);
    const { id } = parse(IdParams, req.params);
    const { row } = loadVisibleRequest(db, reader, id);
    return requestViews(db, reader, [row])[0];
  });

  app.post("/api/requests/:id/approve", async (req) => {
    const reader = requireReader(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(DecideBody, req.body ?? {});
    const { row, requester } = loadVisibleRequest(db, reader, id);
    const view = requestViews(db, reader, [row])[0]!;
    if (!view.canApprove) {
      if (row.requestedBy === reader.userId && reader.role !== "admin") throw httpError(403, "Someone else has to approve your request");
      throw httpError(409, `This request is ${row.status}`);
    }
    // A parent can't approve past the kid's limit: that book would stay locked for them anyway.
    if (requester.role === "kid" && reader.role !== "admin" && row.rating) {
      const kid = db.select().from(users).where(eq(users.id, requester.id)).get()!;
      if (!canSee(toReader(kid), row.rating)) {
        throw httpError(409, "This book is above their reading level. An admin can still get it for the library.");
      }
    }
    setRequest(db, id, { status: "approved", decidedBy: reader.userId, decidedAt: Date.now(), note: body.note ?? null });
    const approved = db.select().from(bookRequests).where(eq(bookRequests.id, id)).get()!;
    opts.startDownload(approved, { via: "auto", auto: true });
    return requestViews(db, reader, [db.select().from(bookRequests).where(eq(bookRequests.id, id)).get()!])[0];
  });

  app.post("/api/requests/:id/decline", async (req) => {
    const reader = requireReader(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(DecideBody, req.body ?? {});
    const { row } = loadVisibleRequest(db, reader, id);
    const view = requestViews(db, reader, [row])[0]!;
    if (!view.canDecline) throw httpError(row.requestedBy === reader.userId ? 403 : 409, `This request is ${row.status}`);
    setRequest(db, id, { status: "declined", decidedBy: reader.userId, decidedAt: Date.now(), note: body.note ?? null });
    return requestViews(db, reader, [db.select().from(bookRequests).where(eq(bookRequests.id, id)).get()!])[0];
  });

  app.delete("/api/requests/:id", async (req, reply) => {
    const reader = requireReader(req);
    const { id } = parse(IdParams, req.params);
    const { row } = loadVisibleRequest(db, reader, id);
    const own = row.requestedBy === reader.userId && row.status === "pending";
    if (!own && reader.role !== "admin") throw httpError(403, "Only pending requests can be withdrawn");
    db.delete(bookRequests).where(eq(bookRequests.id, id)).run();
    reply.code(204);
  });

  /** Admin: start (or restart) the download for an approved or failed request. */
  app.post("/api/admin/requests/:id/download", async (req, reply) => {
    const reader = requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(DownloadBody, req.body ?? {});
    const { row } = loadVisibleRequest(db, reader, id);
    if (row.status !== "approved" && row.status !== "failed") throw httpError(409, `This request is ${row.status}`);
    if (body.via === "direct" && !body.url) throw httpError(400, "url: required for a direct download");
    const jobId = opts.startDownload(row, { via: body.via, url: body.url, auto: false });
    if (!jobId) throw httpError(409, "No downloader is set up");
    reply.code(202);
    return requestViews(db, reader, [db.select().from(bookRequests).where(eq(bookRequests.id, id)).get()!])[0];
  });
}
