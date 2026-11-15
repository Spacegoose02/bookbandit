/**
 * Who may change whom. Kids never manage anyone, including themselves: their birth year,
 * parent links, sign-in method and secrets are edited only by a linked parent or an admin.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { parentLinks, users } from "../db/schema.js";
import type { Reader } from "./reader.js";
import { httpError } from "./plugin.js";

export type UserRow = typeof users.$inferSelect;

export function isLinkedParent(db: Db, parentId: string, kidId: string): boolean {
  return !!db
    .select()
    .from(parentLinks)
    .where(and(eq(parentLinks.parentId, parentId), eq(parentLinks.kidId, kidId)))
    .get();
}

/** True when both are in the same family (people with no family are in none). */
export function sameFamily(a: { familyId: string | null }, b: { familyId: string | null }): boolean {
  return a.familyId != null && a.familyId === b.familyId;
}

/**
 * A parent of this kid: a "parent" in the kid's own family. Parents manage every kid in their
 * family, not only the ones they're linked to, and never kids in another family.
 */
export function isFamilyParentOf(
  actor: { role: Reader["role"]; familyId: string | null; householdId: string },
  kid: { role: Reader["role"]; familyId: string | null; householdId: string },
): boolean {
  return actor.role === "parent" && kid.role === "kid" && actor.householdId === kid.householdId && sameFamily(actor, kid);
}

/** Admin: anyone in the household. Parent: the kids in their own family. Nobody else manages anyone. */
export function canManage(_db: Db, actor: Reader, target: UserRow): boolean {
  if (actor.householdId !== target.householdId) return false;
  if (actor.role === "admin") return true;
  return isFamilyParentOf(actor, target);
}

/** Load a user the actor may see. Others 404 so ids from other households reveal nothing. */
export function loadVisibleUser(db: Db, actor: Reader, id: string): UserRow {
  const u = db.select().from(users).where(eq(users.id, id)).get();
  if (!u || u.householdId !== actor.householdId) throw httpError(404, "Not found");
  if (u.id === actor.userId || canManage(db, actor, u)) return u;
  throw httpError(404, "Not found");
}

export function loadManagedUser(db: Db, actor: Reader, id: string): UserRow {
  const u = loadVisibleUser(db, actor, id);
  if (!canManage(db, actor, u)) throw httpError(403, "Only a parent or admin can change this");
  return u;
}
