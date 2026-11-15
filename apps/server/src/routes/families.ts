/**
 * Families: groups of parents, grown-ups and kids inside the household (the whole server).
 *
 * - A server admin creates, renames and removes families and moves people between them
 *   (`PATCH /api/users/:id { familyId }`).
 * - A parent sees and renames their own family and manages its kids; they never see other
 *   families or anything server-wide (connections, single sign-on, backups, the library).
 * - Other grown-ups see their own family. Kids get 403.
 * - People in no family (for example a new single sign-on account) are listed for admins as
 *   `unassigned` until an admin places them.
 *
 * "Parent approved": a parent (or admin) approves a book for the whole family here, or for one kid
 * through /api/shelves/kids/:kidId/books/:bookId. Kids see both on their Parent approved row, each
 * filtered by the kid's own limit (CLAUDE.md rule 1), so a family pick never lifts a kid's limit.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { books, families, familyPicks, kidShelf, users } from "../db/schema.js";
import { httpError, requireAdmin, requireReader } from "../auth/plugin.js";
import { useAuthErrors } from "../auth/errors.js";
import { profileCard } from "../auth/view.js";
import { toReader, type Reader } from "../auth/reader.js";
import { canSee } from "@bookbandit/shared";
import { visibleBooksWhere } from "../content/lock.js";
import { loadVisibleBook } from "./progress.js";

const name = z.string().trim().min(1).max(60);
const Body = z.object({ name }).strict();
const Params = z.object({ id: z.string().min(1).max(64) });
const BookParams = Params.extend({ bookId: z.string().min(1).max(64) });
const BookOnly = z.object({ id: z.string().min(1).max(64) });

type FamilyRow = typeof families.$inferSelect;

export async function familiesRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  useAuthErrors(app);

  const members = (familyId: string) =>
    db.select().from(users).where(eq(users.familyId, familyId)).orderBy(asc(users.displayName)).all();

  function view(f: FamilyRow) {
    const people = members(f.id).filter((u) => !u.disabled);
    return {
      id: f.id,
      name: f.name,
      createdAt: f.createdAt,
      parents: people.filter((u) => u.role === "parent" || u.role === "admin").length,
      kids: people.filter((u) => u.role === "kid").length,
      members: people.map((u) => profileCard(db, u)),
    };
  }

  /** The family if the reader may see it: admins any in the household, others only their own. */
  function loadFamily(reader: Reader, id: string): FamilyRow {
    const f = db.select().from(families).where(eq(families.id, id)).get();
    if (!f || f.householdId !== reader.householdId) throw httpError(404, "Not found");
    if (reader.role !== "admin" && f.id !== reader.familyId) throw httpError(404, "Not found");
    return f;
  }

  app.get("/api/families", async (req) => {
    const reader = requireReader(req);
    if (reader.isKid) throw httpError(403, "Ask a grown-up");
    if (reader.role !== "admin") {
      const own = reader.familyId ? db.select().from(families).where(eq(families.id, reader.familyId)).get() : undefined;
      return { families: own ? [view(own)] : [], unassigned: [], mine: reader.familyId };
    }
    const all = db.select().from(families).where(eq(families.householdId, reader.householdId)).orderBy(asc(families.name)).all();
    const unassigned = db
      .select()
      .from(users)
      .where(and(eq(users.householdId, reader.householdId), isNull(users.familyId), eq(users.disabled, false)))
      .orderBy(asc(users.displayName))
      .all();
    return { families: all.map(view), unassigned: unassigned.map((u) => profileCard(db, u)), mine: reader.familyId };
  });

  app.get("/api/families/:id", async (req) => {
    const reader = requireReader(req);
    if (reader.isKid) throw httpError(403, "Ask a grown-up");
    return view(loadFamily(reader, Params.parse(req.params).id));
  });

  /** Admin, or a parent of this family: who may approve books for it. */
  function loadFamilyToApprove(reader: Reader, id: string): FamilyRow {
    const f = loadFamily(reader, id);
    if (reader.role !== "admin" && reader.role !== "parent") throw httpError(403, "Only a parent can approve books");
    return f;
  }

  const kidsOf = (familyId: string) =>
    db
      .select()
      .from(users)
      .where(and(eq(users.familyId, familyId), eq(users.role, "kid"), eq(users.disabled, false)))
      .orderBy(asc(users.displayName))
      .all();

  /** Books approved for the whole family, as the viewer may see them. */
  app.get("/api/families/:id/approved", async (req) => {
    const reader = requireReader(req);
    if (reader.isKid) throw httpError(403, "Ask a grown-up");
    const f = loadFamily(reader, Params.parse(req.params).id);
    const rows = db
      .select({ id: books.id, title: books.title, coverPath: books.coverPath, rating: books.rating, addedAt: familyPicks.createdAt, addedBy: users.displayName })
      .from(familyPicks)
      .innerJoin(books, eq(books.id, familyPicks.bookId))
      .leftJoin(users, eq(users.id, familyPicks.addedBy))
      .where(and(eq(familyPicks.familyId, f.id), visibleBooksWhere(reader)))
      .orderBy(desc(familyPicks.createdAt))
      .all();
    return { items: rows };
  });

  /**
   * Approve a book for every kid in the family. Kids above their limit still won't see it; the
   * answer names them so the parent knows (the parent can see the book, so that's no leak).
   */
  app.put("/api/families/:id/approved/:bookId", async (req) => {
    const reader = requireReader(req);
    const { id, bookId } = BookParams.parse(req.params);
    const f = loadFamilyToApprove(reader, id);
    const book = loadVisibleBook(db, reader, bookId);
    if (!book.approved) throw httpError(422, "This book is still waiting in the inbox");
    db.insert(familyPicks).values({ familyId: f.id, bookId: book.id, addedBy: reader.userId }).onConflictDoNothing().run();
    const tooYoung = kidsOf(f.id).filter((k) => !canSee(toReader(k), book.rating)).map((k) => k.displayName);
    return { ok: true, hiddenFrom: tooYoung };
  });

  app.delete("/api/families/:id/approved/:bookId", async (req) => {
    const reader = requireReader(req);
    const { id, bookId } = BookParams.parse(req.params);
    const f = loadFamilyToApprove(reader, id);
    db.delete(familyPicks).where(and(eq(familyPicks.familyId, f.id), eq(familyPicks.bookId, bookId))).run();
    return { ok: true };
  });

  /**
   * For the book page: is this book approved for the viewer's family, and for which of its kids?
   * Parents and admins only; lists the viewer's own family's kids.
   */
  app.get("/api/books/:id/approvals", async (req) => {
    const reader = requireReader(req);
    if (reader.role !== "admin" && reader.role !== "parent") throw httpError(403, "Only a parent can approve books");
    const book = loadVisibleBook(db, reader, BookOnly.parse(req.params).id);
    if (!reader.familyId) return { family: null, kids: [] };
    const f = db.select().from(families).where(eq(families.id, reader.familyId)).get();
    if (!f) return { family: null, kids: [] };
    const kids = kidsOf(f.id);
    const picked = new Set(
      kids.length
        ? db
            .select({ kidId: kidShelf.kidId })
            .from(kidShelf)
            .where(and(eq(kidShelf.bookId, book.id), inArray(kidShelf.kidId, kids.map((k) => k.id))))
            .all()
            .map((r) => r.kidId)
        : [],
    );
    const forFamily = !!db.select().from(familyPicks).where(and(eq(familyPicks.familyId, f.id), eq(familyPicks.bookId, book.id))).get();
    return {
      family: { id: f.id, name: f.name, approved: forFamily },
      kids: kids.map((k) => ({
        id: k.id,
        displayName: k.displayName,
        avatar: k.avatar,
        approved: picked.has(k.id),
        canSee: canSee(toReader(k), book.rating),
      })),
    };
  });

  app.post("/api/families", async (req, reply) => {
    const reader = requireAdmin(req);
    const body = Body.parse(req.body);
    const [f] = db.insert(families).values({ householdId: reader.householdId, name: body.name }).returning().all();
    reply.status(201);
    return view(f!);
  });

  /** Rename: an admin, or a parent of that family. */
  app.patch("/api/families/:id", async (req) => {
    const reader = requireReader(req);
    const f = loadFamily(reader, Params.parse(req.params).id);
    if (reader.role !== "admin" && reader.role !== "parent") throw httpError(403, "Only a parent can rename the family");
    const body = Body.parse(req.body);
    db.update(families).set({ name: body.name }).where(eq(families.id, f.id)).run();
    return view(db.select().from(families).where(eq(families.id, f.id)).get()!);
  });

  /** Admin: remove an empty family. People are never deleted with it, so move them out first. */
  app.delete("/api/families/:id", async (req) => {
    const reader = requireAdmin(req);
    const f = loadFamily(reader, Params.parse(req.params).id);
    const n = db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.familyId, f.id)).get()!.n;
    if (n > 0) throw httpError(409, "Move everyone to another family first");
    db.delete(families).where(eq(families.id, f.id)).run();
    return { ok: true };
  });
}
