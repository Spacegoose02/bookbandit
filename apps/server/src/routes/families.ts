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
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { families, users } from "../db/schema.js";
import { httpError, requireAdmin, requireReader } from "../auth/plugin.js";
import { useAuthErrors } from "../auth/errors.js";
import { profileCard } from "../auth/view.js";
import type { Reader } from "../auth/reader.js";

const name = z.string().trim().min(1).max(60);
const Body = z.object({ name }).strict();
const Params = z.object({ id: z.string().min(1).max(64) });

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
