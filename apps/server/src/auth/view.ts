/** What the API returns about a person. Never includes secret hashes. */
import { eq } from "drizzle-orm";
import type { ProfileSignIn } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { parentLinks, userIdentities } from "../db/schema.js";
import type { UserRow } from "./permissions.js";

export function signInKind(u: UserRow, identities: { provider: string }[]): ProfileSignIn {
  if (u.role === "kid") {
    if (u.kidSignInMethod === "pin" || u.kidSignInMethod === "picture") return u.secretHash ? u.kidSignInMethod : "none";
    return u.kidSignInMethod === "google" ? "google" : "none";
  }
  if (identities.some((i) => i.provider === "local") && u.secretHash) return "password";
  return identities.some((i) => i.provider === "tinyauth") ? "google" : "none";
}

/** Minimal card for the profile picker. */
export function profileCard(db: Db, u: UserRow) {
  const ids = db.select().from(userIdentities).where(eq(userIdentities.userId, u.id)).all();
  return {
    id: u.id,
    displayName: u.displayName,
    avatar: u.avatar,
    role: u.role,
    signIn: signInKind(u, ids),
  };
}

/** Full view for the person themselves, a linked parent, or an admin. */
export function userView(db: Db, u: UserRow) {
  const ids = db.select().from(userIdentities).where(eq(userIdentities.userId, u.id)).all();
  const parents =
    u.role === "kid"
      ? db.select({ id: parentLinks.parentId }).from(parentLinks).where(eq(parentLinks.kidId, u.id)).all()
      : [];
  const kids =
    u.role !== "kid"
      ? db.select({ id: parentLinks.kidId }).from(parentLinks).where(eq(parentLinks.parentId, u.id)).all()
      : [];
  return {
    id: u.id,
    householdId: u.householdId,
    displayName: u.displayName,
    role: u.role,
    birthYear: u.birthYear,
    explicitOptIn: u.role === "kid" ? false : u.explicitOptIn,
    avatar: u.avatar,
    theme: u.theme,
    kidSignInMethod: u.kidSignInMethod,
    signIn: signInKind(u, ids),
    disabled: u.disabled,
    identities: ids.map((i) => ({ id: i.id, provider: i.provider, subject: i.subject })),
    parentIds: parents.map((p) => p.id),
    kidIds: kids.map((k) => k.id),
    createdAt: u.createdAt,
  };
}
