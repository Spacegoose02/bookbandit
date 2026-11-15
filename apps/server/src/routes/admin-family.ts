/**
 * Parent dashboard: what each kid is reading, what they asked for, and their Barnaby AI chats.
 *
 * Read-only. A parent sees the kids in their own family; an admin sees every kid in the
 * household; nobody else (kids and plain adults get 403). Book lists go through
 * visibleBooksWhere for the parent (CLAUDE.md rule 1). AI chats are shown read-only and are
 * never editable or deletable here, so a kid can't ask a parent to "clean up" the log.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ageFromBirthYear, canManageKids, maxAllowedRating } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { aiMessages, authors, bookAuthors, bookRequests, books, families, readingProgress, users } from "../db/schema.js";
import { httpError, requireReader } from "../auth/plugin.js";
import { useAuthErrors } from "../auth/errors.js";
import { loadManagedUser, type UserRow } from "../auth/permissions.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";

const DAY = 24 * 60 * 60 * 1000;
const KidParams = z.object({ id: z.string().min(1).max(64) });
const ChatParams = KidParams.extend({ conversationId: z.string().min(1).max(200) });

export async function familyRoutes(app: FastifyInstance, opts: { db: Db; now?: () => number }) {
  const { db } = opts;
  const now = opts.now ?? Date.now;
  useAuthErrors(app);

  function requireGrownUpManager(req: Parameters<typeof requireReader>[0]): Reader {
    const reader = requireReader(req);
    if (!canManageKids(reader.role)) throw httpError(403, "Only a parent or admin can see the family dashboard");
    return reader;
  }

  function loadKid(reader: Reader, id: string): UserRow {
    const kid = loadManagedUser(db, reader, id);
    if (kid.role !== "kid") throw httpError(404, "Not found");
    return kid;
  }

  function myKids(reader: Reader): UserRow[] {
    if (reader.role === "admin") {
      return db
        .select()
        .from(users)
        .where(and(eq(users.householdId, reader.householdId), eq(users.role, "kid")))
        .orderBy(asc(users.displayName))
        .all();
    }
    if (!reader.familyId) return [];
    return db
      .select()
      .from(users)
      .where(and(eq(users.householdId, reader.householdId), eq(users.familyId, reader.familyId), eq(users.role, "kid")))
      .orderBy(asc(users.displayName))
      .all();
  }

  function kidCard(k: UserRow) {
    const today = new Date(now());
    return {
      id: k.id,
      displayName: k.displayName,
      avatar: k.avatar,
      birthYear: k.birthYear,
      age: k.birthYear != null ? ageFromBirthYear(k.birthYear, today) : null,
      maxRating: maxAllowedRating({ birthYear: k.birthYear, isKid: true, explicitOptIn: false }, today),
      kidSignInMethod: k.kidSignInMethod,
      disabled: k.disabled,
      familyId: k.familyId,
    };
  }

  /** Progress rows for a kid, limited to books the viewing grown-up may see. */
  function progressFor(reader: Reader, kidId: string, limit: number) {
    return db
      .select({
        bookId: readingProgress.bookId,
        title: books.title,
        coverPath: books.coverPath,
        rating: books.rating,
        percent: readingProgress.percent,
        finished: readingProgress.finished,
        deviceName: readingProgress.deviceName,
        updatedAt: readingProgress.serverUpdatedAt,
      })
      .from(readingProgress)
      .innerJoin(books, eq(books.id, readingProgress.bookId))
      .where(and(eq(readingProgress.userId, kidId), visibleBooksWhere(reader, new Date(now()))))
      .orderBy(desc(readingProgress.serverUpdatedAt))
      .limit(limit)
      .all();
  }

  function stats(reader: Reader, kidId: string) {
    const rows = progressFor(reader, kidId, 1000);
    const monthAgo = now() - 30 * DAY;
    const weekAgo = now() - 7 * DAY;
    const pendingRequests =
      db
        .select({ n: sql<number>`count(*)` })
        .from(bookRequests)
        .where(and(eq(bookRequests.requestedBy, kidId), eq(bookRequests.status, "pending")))
        .get()?.n ?? 0;
    const ai = db
      .select({ n: sql<number>`count(*)`, flagged: sql<number>`sum(case when ${aiMessages.moderation} is not null then 1 else 0 end)` })
      .from(aiMessages)
      .where(and(eq(aiMessages.userId, kidId), eq(aiMessages.role, "user"), gte(aiMessages.createdAt, weekAgo)))
      .get();
    const last = rows[0];
    return {
      readingNow: rows.filter((r) => !r.finished).length,
      finished: rows.filter((r) => r.finished).length,
      finishedLast30Days: rows.filter((r) => r.finished && r.updatedAt >= monthAgo).length,
      booksOpenedLast7Days: rows.filter((r) => r.updatedAt >= weekAgo).length,
      lastReadAt: last?.updatedAt ?? null,
      lastBook: last ? { id: last.bookId, title: last.title } : null,
      pendingRequests,
      aiQuestionsLast7Days: ai?.n ?? 0,
      aiFlaggedLast7Days: ai?.flagged ?? 0,
    };
  }

  function authorsFor(ids: string[]) {
    const by = new Map<string, string[]>();
    if (!ids.length) return by;
    for (const r of db
      .select({ bookId: bookAuthors.bookId, name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(inArray(bookAuthors.bookId, ids))
      .orderBy(asc(bookAuthors.position))
      .all())
      by.set(r.bookId, [...(by.get(r.bookId) ?? []), r.name]);
    return by;
  }

  // --- Routes -------------------------------------------------------------------

  app.get("/api/family/kids", async (req) => {
    const reader = requireGrownUpManager(req);
    const kids = myKids(reader);
    const familyIds = [...new Set(kids.map((k) => k.familyId).filter((x): x is string => !!x))];
    const familyRows = familyIds.length
      ? db.select({ id: families.id, name: families.name }).from(families).where(inArray(families.id, familyIds)).orderBy(asc(families.name)).all()
      : [];
    return { kids: kids.map((k) => ({ ...kidCard(k), stats: stats(reader, k.id) })), families: familyRows };
  });

  app.get("/api/family/kids/:id", async (req) => {
    const reader = requireGrownUpManager(req);
    const { id } = KidParams.parse(req.params);
    const kid = loadKid(reader, id);
    const reading = progressFor(reader, kid.id, 60);
    const authorsBy = authorsFor(reading.map((r) => r.bookId));
    const requests = db
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.requestedBy, kid.id))
      .orderBy(desc(bookRequests.createdAt))
      .limit(50)
      .all()
      .map((r) => ({ id: r.id, title: r.title, author: r.author, rating: r.rating, status: r.status, note: r.note, createdAt: r.createdAt }));
    const chats = db
      .select({
        conversationId: aiMessages.conversationId,
        startedAt: sql<number>`min(${aiMessages.createdAt})`,
        lastAt: sql<number>`max(${aiMessages.createdAt})`,
        messages: sql<number>`count(*)`,
        flagged: sql<number>`sum(case when ${aiMessages.moderation} is not null then 1 else 0 end)`,
        bookId: sql<string | null>`max(${aiMessages.bookId})`,
      })
      .from(aiMessages)
      .where(eq(aiMessages.userId, kid.id))
      .groupBy(aiMessages.conversationId)
      .orderBy(desc(sql`max(${aiMessages.createdAt})`))
      .limit(50)
      .all();
    const firstQuestions = new Map(
      chats.length
        ? db
            .select({ conversationId: aiMessages.conversationId, content: aiMessages.content, createdAt: aiMessages.createdAt })
            .from(aiMessages)
            .where(
              and(
                eq(aiMessages.userId, kid.id),
                eq(aiMessages.role, "user"),
                inArray(
                  aiMessages.conversationId,
                  chats.map((c) => c.conversationId),
                ),
              ),
            )
            .orderBy(desc(aiMessages.createdAt))
            .all()
            .map((m) => [m.conversationId, m.content] as const)
        : [],
    );
    // Book titles in chats, only when the grown-up may see the book.
    const chatBookIds = chats.map((c) => c.bookId).filter((x): x is string => !!x);
    const chatBooks = new Map(
      chatBookIds.length
        ? db
            .select({ id: books.id, title: books.title })
            .from(books)
            .where(and(inArray(books.id, chatBookIds), visibleBooksWhere(reader, new Date(now()))))
            .all()
            .map((b) => [b.id, b.title] as const)
        : [],
    );
    return {
      kid: kidCard(kid),
      stats: stats(reader, kid.id),
      reading: reading.map((r) => ({ ...r, authors: authorsBy.get(r.bookId) ?? [] })),
      requests,
      chats: chats.map((c) => ({
        ...c,
        flagged: c.flagged ?? 0,
        bookTitle: c.bookId ? (chatBooks.get(c.bookId) ?? null) : null,
        bookId: c.bookId && chatBooks.has(c.bookId) ? c.bookId : null,
        // the map keeps the last value set, and rows come newest first, so this is the first question
        preview: (firstQuestions.get(c.conversationId) ?? "").slice(0, 160),
      })),
    };
  });

  /** One AI conversation, read-only, oldest message first. System prompts are left out. */
  app.get("/api/family/kids/:id/chats/:conversationId", async (req) => {
    const reader = requireGrownUpManager(req);
    const { id, conversationId } = ChatParams.parse(req.params);
    const kid = loadKid(reader, id);
    const rows = db
      .select()
      .from(aiMessages)
      .where(and(eq(aiMessages.userId, kid.id), eq(aiMessages.conversationId, conversationId), isNotNull(aiMessages.content)))
      .orderBy(asc(aiMessages.createdAt))
      .all()
      .filter((m) => m.role !== "system");
    if (!rows.length) throw httpError(404, "Not found");
    return {
      conversationId,
      messages: rows.map((m) => ({ id: m.id, role: m.role, content: m.content, moderation: m.moderation, createdAt: m.createdAt })),
    };
  });
}
