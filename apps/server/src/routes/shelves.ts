/**
 * Home shelves: Continue reading, Finished, and kid shelves that parents fill by hand.
 *
 * Kid shelves are filtered by the content lock twice: as the kid (so a parent can never put a
 * book above the kid's limit on it, even if the book is re-rated later) and as the viewer.
 */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { canManageKids } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { books, kidShelf, parentLinks, readingProgress, users } from "../db/schema.js";
import { requireReader } from "../auth/plugin.js";
import type { Reader } from "../auth/reader.js";
import { assertCanSee, ContentLockedError, visibleBooksWhere } from "../content/lock.js";
import { loadVisibleBook, parseOr400, toProgressRecord } from "./progress.js";

const bookSummary = {
  id: books.id,
  title: books.title,
  publishedYear: books.publishedYear,
  rating: books.rating,
  coverPath: books.coverPath,
  kindleOnly: books.kindleOnly,
};

const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const KidShelfQuery = z.object({ storyteller: z.enum(["true", "false"]).optional() });
const KidShelfBody = z.object({ storyteller: z.boolean().default(false) }).prefault({});

function forbidden(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 403 });
}

export async function shelfRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  function readingShelf(reader: Reader, finished: boolean, limit: number) {
    const rows = db
      .select({ book: bookSummary, progress: readingProgress })
      .from(readingProgress)
      .innerJoin(books, eq(books.id, readingProgress.bookId))
      .where(
        and(
          eq(readingProgress.userId, reader.userId),
          eq(readingProgress.finished, finished),
          finished ? undefined : gt(readingProgress.percent, 0),
          visibleBooksWhere(reader),
        ),
      )
      .orderBy(desc(readingProgress.clientUpdatedAt))
      .limit(limit)
      .all();
    return { items: rows.map((r) => ({ book: r.book, progress: toProgressRecord(r.progress) })) };
  }

  /** Books started but not finished, most recently read first. */
  app.get("/api/shelves/continue", async (req, reply) => {
    const reader = requireReader(req);
    const q = parseOr400(LimitQuery, req.query, reply);
    if (!q) return reply;
    return readingShelf(reader, false, q.limit);
  });

  app.get("/api/shelves/finished", async (req, reply) => {
    const reader = requireReader(req);
    const q = parseOr400(LimitQuery, req.query, reply);
    if (!q) return reply;
    return readingShelf(reader, true, q.limit);
  });

  /**
   * The kid whose shelf this is, as a Reader (for the content lock), after checking the viewer
   * may look at it: the kid themselves, a linked parent, or an admin in the same household.
   * `manage` additionally requires parent/admin. Kids that don't exist or aren't visible → 404.
   */
  function resolveKid(viewer: Reader, kidParam: string, manage: boolean): Reader {
    const kidId = kidParam === "me" ? viewer.userId : kidParam;
    const kid = db.select().from(users).where(eq(users.id, kidId)).get();
    if (!kid || kid.role !== "kid" || kid.householdId !== viewer.householdId) throw new ContentLockedError();

    const isSelf = kid.id === viewer.userId;
    const isLinkedParent =
      viewer.role === "parent" &&
      db
        .select({ kidId: parentLinks.kidId })
        .from(parentLinks)
        .where(and(eq(parentLinks.parentId, viewer.userId), eq(parentLinks.kidId, kid.id)))
        .get() !== undefined;
    const isAdmin = viewer.role === "admin";

    if (manage) {
      if (!canManageKids(viewer.role)) throw forbidden("Ask a parent to change your shelf");
      if (!isAdmin && !isLinkedParent) throw new ContentLockedError();
    } else if (!isSelf && !isLinkedParent && !isAdmin) {
      throw new ContentLockedError();
    }

    return {
      userId: kid.id,
      householdId: kid.householdId,
      role: kid.role,
      displayName: kid.displayName,
      birthYear: kid.birthYear,
      isKid: true,
      explicitOptIn: false,
    };
  }

  /** A kid's hand-picked shelf. `kidId` may be "me" for the signed-in kid. */
  app.get<{ Params: { kidId: string } }>("/api/shelves/kids/:kidId", async (req, reply) => {
    const viewer = requireReader(req);
    const q = parseOr400(KidShelfQuery, req.query, reply);
    if (!q) return reply;
    const kid = resolveKid(viewer, req.params.kidId, false);

    const rows = db
      .select({ book: bookSummary, storyteller: kidShelf.storyteller, addedAt: kidShelf.createdAt })
      .from(kidShelf)
      .innerJoin(books, eq(books.id, kidShelf.bookId))
      .where(
        and(
          eq(kidShelf.kidId, kid.userId),
          q.storyteller === undefined ? undefined : eq(kidShelf.storyteller, q.storyteller === "true"),
          visibleBooksWhere(kid),
          visibleBooksWhere(viewer),
        ),
      )
      .orderBy(desc(kidShelf.createdAt))
      .all();

    // The kid's own progress on each book, so the shelf can show how far along they are.
    const ids = rows.map((r) => r.book.id);
    const progress = ids.length
      ? db
          .select()
          .from(readingProgress)
          .where(and(eq(readingProgress.userId, kid.userId), inArray(readingProgress.bookId, ids)))
          .all()
      : [];
    const byBook = new Map(progress.map((p) => [p.bookId, toProgressRecord(p)]));

    return {
      kid: { id: kid.userId, displayName: kid.displayName },
      items: rows.map((r) => ({ ...r, progress: byBook.get(r.book.id) ?? null })),
    };
  });

  /** Parent/admin puts a book on a kid's shelf (or toggles storyteller mode for it). */
  app.put<{ Params: { kidId: string; bookId: string } }>(
    "/api/shelves/kids/:kidId/books/:bookId",
    async (req, reply) => {
      const viewer = requireReader(req);
      const body = parseOr400(KidShelfBody, req.body ?? {}, reply);
      if (!body) return reply;
      const kid = resolveKid(viewer, req.params.kidId, true);
      const book = loadVisibleBook(db, viewer, req.params.bookId);
      // Only an admin gets this far with an unapproved book; it isn't a reading-level problem.
      if (!book.approved) return reply.code(422).send({ error: "This book is still waiting in the inbox" });
      try {
        assertCanSee(kid, book);
      } catch (err) {
        if (!(err instanceof ContentLockedError)) throw err;
        // The parent can see the book, so saying why is fine.
        return reply.code(422).send({ error: `This book is above ${kid.displayName}'s reading level` });
      }
      db.insert(kidShelf)
        .values({ kidId: kid.userId, bookId: book.id, storyteller: body.storyteller, addedBy: viewer.userId })
        .onConflictDoUpdate({ target: [kidShelf.kidId, kidShelf.bookId], set: { storyteller: body.storyteller } })
        .run();
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { kidId: string; bookId: string } }>(
    "/api/shelves/kids/:kidId/books/:bookId",
    async (req, reply) => {
      const viewer = requireReader(req);
      const kid = resolveKid(viewer, req.params.kidId, true);
      db.delete(kidShelf)
        .where(and(eq(kidShelf.kidId, kid.userId), eq(kidShelf.bookId, req.params.bookId)))
        .run();
      return reply.code(204).send();
    },
  );
}
