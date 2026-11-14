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

/** Admin: anyone in the household. Parent: kids they are linked to. Nobody else manages anyone. */
export function canManage(db: Db, actor: Reader, target: UserRow): boolean {
  if (actor.householdId !== target.householdId) return false;
  if (actor.role === "admin") return true;
  if (actor.role === "parent" && target.role === "kid") return isLinkedParent(db, actor.userId, target.id);
  return false;
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
