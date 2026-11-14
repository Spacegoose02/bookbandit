/**
 * Reading and listening time, for the parent dashboard and streaks.
 *
 * Clients send a heartbeat about once a minute while a book is open and the person is
 * active. The server caps each heartbeat by the wall-clock time since the previous one
 * (plus a little slack), so a stuck or tampered client can't inflate the total.
 *
 * Stats are visible to the person themselves, a linked parent, or an admin in the same
 * household. Per-book rows go through the content lock as both the subject and the viewer.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, sql, sum } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { books, parentLinks, readingSessions, users } from "../db/schema.js";
import { httpError, requireReader } from "../auth/plugin.js";
import type { Reader } from "../auth/reader.js";
import { ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import { loadVisibleBook, parseOr400 } from "./progress.js";

/** Longest single heartbeat we accept, in seconds. */
export const MAX_BEAT_SECONDS = 300;
/** Slack for clock jitter and slow networks when capping by wall time. */
const SLACK_SECONDS = 5;

const Heartbeat = z.object({
  sessionId: z.string().uuid(),
  bookId: z.string().min(1).max(64),
  seconds: z.number().int().min(1).max(MAX_BEAT_SECONDS),
  kind: z.enum(["read", "listen"]).default("read"),
  deviceName: z.string().trim().min(1).max(80).optional(),
});

const StatsQuery = z.object({
  userId: z.string().max(64).optional(),
  days: z.coerce.number().int().min(1).max(90).default(7),
  /** Minutes to add to UTC to get the viewer's local time (e.g. -300 for New York in winter). */
  utcOffset: z.coerce.number().int().min(-840).max(840).default(0),
});

export async function readingTimeRoutes(app: FastifyInstance, opts: { db: Db; now?: () => number }) {
  const { db } = opts;
  const now = opts.now ?? Date.now;

  app.post("/api/reading/heartbeat", async (req, reply) => {
    const reader = requireReader(req);
    const body = parseOr400(Heartbeat, req.body, reply);
    if (!body) return reply;
    loadVisibleBook(db, reader, body.bookId);
    const t = now();

    const existing = db.select().from(readingSessions).where(eq(readingSessions.id, body.sessionId)).get();
    if (existing) {
      if (existing.userId !== reader.userId || existing.bookId !== body.bookId) {
        return reply.code(409).send({ error: "Session id already in use" });
      }
      const allowed = Math.max(0, Math.floor((t - existing.lastBeatAt) / 1000) + SLACK_SECONDS);
      const delta = Math.min(body.seconds, allowed);
      const [row] = db
        .update(readingSessions)
        .set({ seconds: existing.seconds + delta, lastBeatAt: t })
        .where(eq(readingSessions.id, existing.id))
        .returning()
        .all();
      return { sessionId: row!.id, seconds: row!.seconds, counted: delta };
    }

    const [row] = db
      .insert(readingSessions)
      .values({
        id: body.sessionId,
        userId: reader.userId,
        bookId: body.bookId,
        kind: body.kind,
        deviceName: body.deviceName ?? null,
        startedAt: t - body.seconds * 1000,
        lastBeatAt: t,
        seconds: body.seconds,
      })
      .returning()
      .all();
    return reply.code(201).send({ sessionId: row!.id, seconds: row!.seconds, counted: body.seconds });
  });

  /** The person whose stats are asked for, as a Reader, after checking the viewer may see them. */
  function resolveSubject(viewer: Reader, userId: string | undefined): Reader {
    const id = !userId || userId === "me" ? viewer.userId : userId;
    const u = db.select().from(users).where(eq(users.id, id)).get();
    if (!u || u.householdId !== viewer.householdId) throw new ContentLockedError();
    const isSelf = u.id === viewer.userId;
    const isAdmin = viewer.role === "admin";
    const isLinkedParent =
      viewer.role === "parent" &&
      !!db
        .select({ kidId: parentLinks.kidId })
        .from(parentLinks)
        .where(and(eq(parentLinks.parentId, viewer.userId), eq(parentLinks.kidId, u.id)))
        .get();
    if (!isSelf && !isAdmin && !isLinkedParent) throw new ContentLockedError();
    return {
      userId: u.id,
      householdId: u.householdId,
      role: u.role,
      displayName: u.displayName,
      birthYear: u.birthYear,
      isKid: u.role === "kid",
      explicitOptIn: u.role === "kid" ? false : u.explicitOptIn,
    };
  }

  app.get("/api/reading/stats", async (req, reply) => {
    const viewer = requireReader(req);
    const q = parseOr400(StatsQuery, req.query, reply);
    if (!q) return reply;
    if (q.userId && q.userId !== "me" && viewer.role === "kid") throw httpError(403, "Ask a grown-up");
    const subject = resolveSubject(viewer, q.userId);

    const t = now();
    const offsetMs = q.utcOffset * 60_000;
    // Start of the local day, `days - 1` days ago.
    const localToday = Math.floor((t + offsetMs) / 86_400_000);
    const fromLocalDay = localToday - (q.days - 1);
    const fromMs = fromLocalDay * 86_400_000 - offsetMs;
    const mine = and(eq(readingSessions.userId, subject.userId), gte(readingSessions.startedAt, fromMs));

    const dayExpr = sql<number>`cast((${readingSessions.startedAt} + ${offsetMs}) / 86400000 as integer)`;
    const perDay = db
      .select({ day: dayExpr, kind: readingSessions.kind, seconds: sum(readingSessions.seconds).mapWith(Number) })
      .from(readingSessions)
      .where(mine)
      .groupBy(dayExpr, readingSessions.kind)
      .all();

    const days = Array.from({ length: q.days }, (_, i) => {
      const day = fromLocalDay + i;
      const rows = perDay.filter((r) => r.day === day);
      const read = rows.find((r) => r.kind === "read")?.seconds ?? 0;
      const listen = rows.find((r) => r.kind === "listen")?.seconds ?? 0;
      return { date: new Date(day * 86_400_000).toISOString().slice(0, 10), readSeconds: read, listenSeconds: listen };
    });

    const perBook = db
      .select({
        id: books.id,
        title: books.title,
        coverPath: books.coverPath,
        seconds: sum(readingSessions.seconds).mapWith(Number),
      })
      .from(readingSessions)
      .innerJoin(books, eq(books.id, readingSessions.bookId))
      .where(and(mine, visibleBooksWhere(subject), visibleBooksWhere(viewer)))
      .groupBy(books.id)
      .orderBy(desc(sum(readingSessions.seconds)))
      .limit(20)
      .all();

    const total = days.reduce((n, d) => n + d.readSeconds + d.listenSeconds, 0);
    const streak = (() => {
      let n = 0;
      for (let i = days.length - 1; i >= 0; i--) {
        const d = days[i]!;
        if (d.readSeconds + d.listenSeconds > 0) n++;
        else if (i === days.length - 1) continue; // today not started yet doesn't break the streak
        else break;
      }
      return n;
    })();

    return {
      user: { id: subject.userId, displayName: subject.displayName },
      totalSeconds: total,
      streakDays: streak,
      days,
      books: perBook,
    };
  });
}
