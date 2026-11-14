/**
 * Family accounts. Kids are always linked to at least one parent. Only a linked parent or an
 * admin can change a kid's birth year, parent links, sign-in method or secret; kids can only
 * change their own avatar and theme.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  isValidPictureSequence,
  isValidPin,
  KID_SIGN_IN_METHODS,
  PASSWORD_MIN_LENGTH,
  ROLES,
  SIGN_IN_PICTURES,
  type Role,
} from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { parentLinks, userIdentities, users } from "../db/schema.js";
import { httpError, requireAdmin, requireReader } from "../auth/plugin.js";
import { canManage, loadManagedUser, loadVisibleUser, type UserRow } from "../auth/permissions.js";
import { hashSecret, pictureSecret, verifySecret } from "../auth/secrets.js";
import { profileCard, userView } from "../auth/view.js";
import { useAuthErrors } from "../auth/errors.js";
import type { Reader } from "../auth/reader.js";

const thisYear = () => new Date().getUTCFullYear();
const birthYear = z.number().int().refine((y) => y >= 1900 && y <= thisYear(), "Not a real birth year");
const displayName = z.string().trim().min(1).max(60);
const avatar = z.string().trim().max(200).nullable();
const theme = z.string().trim().min(1).max(40);
const pin = z.string().refine(isValidPin, "A PIN is 4 to 6 digits");
const pictures = z
  .array(z.enum(SIGN_IN_PICTURES))
  .refine(isValidPictureSequence, "Pick 3 to 5 pictures");
const password = z.string().min(PASSWORD_MIN_LENGTH).max(200);
const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{2,40}$/);
const email = z.string().trim().toLowerCase().email();

const CreateBody = z
  .object({
    displayName,
    role: z.enum(ROLES),
    birthYear: birthYear.optional(),
    avatar: avatar.optional(),
    theme: theme.optional(),
    kidSignInMethod: z.enum(KID_SIGN_IN_METHODS).optional(),
    pin: pin.optional(),
    pictures: pictures.optional(),
    password: password.optional(),
    username: username.optional(),
    email: email.optional(),
    /** Kids: parents to link. The parent creating the kid is always linked. */
    parentIds: z.array(z.string().uuid()).max(10).optional(),
  })
  .strict();

const PatchSelf = z
  .object({
    displayName: displayName.optional(),
    avatar: avatar.optional(),
    theme: theme.optional(),
    explicitOptIn: z.boolean().optional(),
  })
  .strict();

const PatchUser = z
  .object({
    displayName: displayName.optional(),
    birthYear: birthYear.nullable().optional(),
    avatar: avatar.optional(),
    theme: theme.optional(),
    kidSignInMethod: z.enum(KID_SIGN_IN_METHODS).optional(),
    disabled: z.boolean().optional(),
    role: z.enum(ROLES).optional(),
  })
  .strict();

const SecretBody = z.union([
  z.object({ pin }).strict(),
  z.object({ pictures }).strict(),
  z.object({ password }).strict(),
]);

const PasswordBody = z
  .object({ currentPassword: z.string().max(200).optional(), newPassword: password, username: username.optional() })
  .strict();

const IdentityBody = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("tinyauth"), subject: email }).strict(),
  z.object({ provider: z.literal("local"), subject: username }).strict(),
]);

const ParentBody = z.object({ parentId: z.string().uuid() }).strict();

const canBeParent = (role: Role) => role === "parent" || role === "admin";

export async function userRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  useAuthErrors(app);

  const getUser = (id: string) => db.select().from(users).where(eq(users.id, id)).get();
  const me = (reader: Reader) => getUser(reader.userId)!;
  const adminCount = (householdId: string) =>
    db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.householdId, householdId), eq(users.role, "admin"), eq(users.disabled, false)))
      .get()!.n;

  function assertIdentityFree(provider: "tinyauth" | "local", subject: string) {
    const taken = db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)))
      .get();
    if (taken) throw httpError(409, provider === "local" ? "That username is taken" : "That email is already linked");
  }

  /** Parents to link to a kid: must be parents/admins in the same household. */
  function checkParents(actor: Reader, ids: string[]): void {
    if (ids.length === 0) return;
    const rows = db.select().from(users).where(inArray(users.id, ids)).all();
    if (rows.length !== new Set(ids).size || rows.some((r) => r.householdId !== actor.householdId || !canBeParent(r.role))) {
      throw httpError(400, "Parents must be grown-ups in your family with the parent or admin role");
    }
  }

  // ---- me -----------------------------------------------------------------

  app.get("/api/users/me", async (req) => userView(db, me(requireReader(req))));

  app.patch("/api/users/me", async (req) => {
    const reader = requireReader(req);
    const body = PatchSelf.parse(req.body);
    if (reader.isKid && (body.displayName !== undefined || body.explicitOptIn !== undefined)) {
      throw httpError(403, "Ask a grown-up to change that");
    }
    if (Object.keys(body).length) db.update(users).set(body).where(eq(users.id, reader.userId)).run();
    return userView(db, me(reader));
  });

  /** Grown-ups set or change their own local password (and optionally pick a username). */
  app.put("/api/users/me/password", async (req) => {
    const reader = requireReader(req);
    if (reader.isKid) throw httpError(403, "Ask a grown-up to change that");
    const body = PasswordBody.parse(req.body);
    const u = me(reader);
    if (u.secretHash && !(await verifySecret(body.currentPassword ?? "", u.secretHash))) {
      throw httpError(401, "Current password is wrong");
    }
    const hasLocal = db
      .select()
      .from(userIdentities)
      .where(and(eq(userIdentities.userId, u.id), eq(userIdentities.provider, "local")))
      .get();
    if (!hasLocal && !body.username) throw httpError(400, "Pick a username to sign in with");
    const hash = await hashSecret(body.newPassword);
    db.transaction((tx) => {
      if (!hasLocal && body.username) {
        assertIdentityFree("local", body.username);
        tx.insert(userIdentities).values({ userId: u.id, provider: "local", subject: body.username }).run();
      }
      tx.update(users).set({ secretHash: hash }).where(eq(users.id, u.id)).run();
    });
    return userView(db, me(reader));
  });

  // ---- household ----------------------------------------------------------

  app.get("/api/users", async (req) => {
    const reader = requireReader(req);
    const all = db.select().from(users).where(eq(users.householdId, reader.householdId)).orderBy(users.displayName).all();
    const mine = all.filter((u) => u.id === reader.userId || canManage(db, reader, u));
    return {
      users: mine.map((u) => userView(db, u)),
      // Grown-ups see who else is in the family (to add a co-parent); kids only see themselves.
      household: reader.isKid ? [] : all.filter((u) => !u.disabled).map((u) => profileCard(db, u)),
    };
  });

  app.post("/api/users", async (req, reply) => {
    const reader = requireReader(req);
    const body = CreateBody.parse(req.body);
    if (body.role === "kid") {
      if (!canBeParent(reader.role)) throw httpError(403, "Only a parent or admin can add a kid");
    } else if (reader.role !== "admin") {
      throw httpError(403, "Only an admin can add grown-ups");
    }

    let secretHash: string | null = null;
    let kidSignInMethod: UserRow["kidSignInMethod"] = null;
    const parentIds = new Set(body.parentIds ?? []);

    if (body.role === "kid") {
      if (body.birthYear == null) throw httpError(400, "A kid needs a birth year so the right books show up");
      if (body.password || body.username) throw httpError(400, "Kids sign in with a PIN, pictures or Google");
      kidSignInMethod = body.kidSignInMethod ?? (body.pictures ? "picture" : body.pin ? "pin" : body.email ? "google" : "picture");
      if (body.pin && kidSignInMethod !== "pin") throw httpError(400, "A PIN needs the pin sign-in method");
      if (body.pictures && kidSignInMethod !== "picture") throw httpError(400, "Pictures need the picture sign-in method");
      if (kidSignInMethod === "google" && !body.email) throw httpError(400, "Google sign-in needs the kid's email");
      if (body.pin) secretHash = await hashSecret(body.pin);
      if (body.pictures) secretHash = await hashSecret(pictureSecret(body.pictures));
      parentIds.add(reader.userId);
      checkParents(reader, [...parentIds]);
    } else {
      if (body.kidSignInMethod || body.pin || body.pictures) throw httpError(400, "PINs and pictures are for kids");
      if (body.parentIds?.length) throw httpError(400, "Only kids have parents here");
      if (!!body.username !== !!body.password) throw httpError(400, "A username needs a password");
      if (body.password) secretHash = await hashSecret(body.password);
    }
    if (body.email) assertIdentityFree("tinyauth", body.email);
    if (body.username) assertIdentityFree("local", body.username);

    const created = db.transaction((tx) => {
      const [u] = tx
        .insert(users)
        .values({
          householdId: reader.householdId,
          displayName: body.displayName,
          role: body.role,
          birthYear: body.birthYear ?? null,
          avatar: body.avatar ?? null,
          ...(body.theme ? { theme: body.theme } : {}),
          kidSignInMethod,
          secretHash,
        })
        .returning()
        .all();
      if (body.email) tx.insert(userIdentities).values({ userId: u!.id, provider: "tinyauth", subject: body.email }).run();
      if (body.username) tx.insert(userIdentities).values({ userId: u!.id, provider: "local", subject: body.username }).run();
      for (const parentId of parentIds) tx.insert(parentLinks).values({ parentId, kidId: u!.id }).run();
      return u!;
    });
    reply.status(201);
    return userView(db, created);
  });

  // ---- one person ---------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const reader = requireReader(req);
    return userView(db, loadVisibleUser(db, reader, req.params.id));
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const reader = requireReader(req);
    const body = PatchUser.parse(req.body);
    const target = loadManagedUser(db, reader, req.params.id);
    const patch: Partial<typeof users.$inferInsert> = {};

    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.avatar !== undefined) patch.avatar = body.avatar;
    if (body.theme !== undefined) patch.theme = body.theme;
    if (body.birthYear !== undefined) patch.birthYear = body.birthYear;

    const role = body.role ?? target.role;
    if (body.role !== undefined && body.role !== target.role) {
      if (reader.role !== "admin") throw httpError(403, "Only an admin can change roles");
      if (target.id === reader.userId) throw httpError(400, "You can't change your own role");
      if (target.role === "admin" && adminCount(target.householdId) <= 1) throw httpError(400, "Keep at least one admin");
      patch.role = body.role;
      if (body.role === "kid") {
        const hasParent = db.select().from(parentLinks).where(eq(parentLinks.kidId, target.id)).get();
        if (!hasParent) throw httpError(400, "Link a parent before making someone a kid");
        patch.explicitOptIn = false;
        patch.secretHash = null; // a grown-up's password is not a kid's PIN
        patch.kidSignInMethod = body.kidSignInMethod ?? "picture";
      } else {
        patch.kidSignInMethod = null;
        if (target.role === "kid") patch.secretHash = null;
      }
    }
    const nextBirthYear = body.birthYear !== undefined ? body.birthYear : target.birthYear;
    if (role === "kid" && nextBirthYear == null) {
      throw httpError(400, "A kid needs a birth year");
    }

    if (body.kidSignInMethod !== undefined && patch.role === undefined) {
      if (role !== "kid") throw httpError(400, "Sign-in methods are for kids");
      if (body.kidSignInMethod !== target.kidSignInMethod) {
        patch.kidSignInMethod = body.kidSignInMethod;
        patch.secretHash = null; // old PIN doesn't carry over to pictures (and vice versa)
      }
    }

    if (body.disabled !== undefined) {
      if (target.id === reader.userId) throw httpError(400, "You can't disable yourself");
      if (body.disabled && target.role === "admin" && adminCount(target.householdId) <= 1) {
        throw httpError(400, "Keep at least one admin");
      }
      patch.disabled = body.disabled;
    }

    if (Object.keys(patch).length) db.update(users).set(patch).where(eq(users.id, target.id)).run();
    return userView(db, getUser(target.id)!);
  });

  /** Set a kid's PIN or pictures, or reset a grown-up's password (admin). */
  app.put<{ Params: { id: string } }>("/api/users/:id/secret", async (req) => {
    const reader = requireReader(req);
    const body = SecretBody.parse(req.body);
    const target = loadManagedUser(db, reader, req.params.id);
    let hash: string;
    const patch: Partial<typeof users.$inferInsert> = {};
    if ("password" in body) {
      if (target.role === "kid") throw httpError(400, "Kids sign in with a PIN or pictures");
      hash = await hashSecret(body.password);
    } else {
      if (target.role !== "kid") throw httpError(400, "PINs and pictures are for kids");
      if ("pin" in body) {
        hash = await hashSecret(body.pin);
        patch.kidSignInMethod = "pin";
      } else {
        hash = await hashSecret(pictureSecret(body.pictures));
        patch.kidSignInMethod = "picture";
      }
    }
    db.update(users)
      .set({ ...patch, secretHash: hash })
      .where(eq(users.id, target.id))
      .run();
    return userView(db, getUser(target.id)!);
  });

  app.post<{ Params: { id: string } }>("/api/users/:id/identities", async (req, reply) => {
    const reader = requireReader(req);
    const body = IdentityBody.parse(req.body);
    const target = loadManagedUser(db, reader, req.params.id);
    if (body.provider === "local" && target.role === "kid") throw httpError(400, "Kids sign in with a PIN or pictures");
    assertIdentityFree(body.provider, body.subject);
    db.insert(userIdentities).values({ userId: target.id, provider: body.provider, subject: body.subject }).run();
    reply.status(201);
    return userView(db, getUser(target.id)!);
  });

  app.delete<{ Params: { id: string; identityId: string } }>("/api/users/:id/identities/:identityId", async (req) => {
    const reader = requireReader(req);
    const target = loadManagedUser(db, reader, req.params.id);
    const res = db
      .delete(userIdentities)
      .where(and(eq(userIdentities.id, req.params.identityId), eq(userIdentities.userId, target.id)))
      .run();
    if (res.changes === 0) throw httpError(404, "Not found");
    return userView(db, getUser(target.id)!);
  });

  // ---- parent links -------------------------------------------------------

  app.post<{ Params: { id: string } }>("/api/users/:id/parents", async (req, reply) => {
    const reader = requireReader(req);
    const { parentId } = ParentBody.parse(req.body);
    const kid = loadManagedUser(db, reader, req.params.id);
    if (kid.role !== "kid") throw httpError(400, "Only kids have parents here");
    checkParents(reader, [parentId]);
    db.insert(parentLinks).values({ parentId, kidId: kid.id }).onConflictDoNothing().run();
    reply.status(201);
    return userView(db, kid);
  });

  app.delete<{ Params: { id: string; parentId: string } }>("/api/users/:id/parents/:parentId", async (req) => {
    const reader = requireReader(req);
    const kid = loadManagedUser(db, reader, req.params.id);
    const links = db.select().from(parentLinks).where(eq(parentLinks.kidId, kid.id)).all();
    if (!links.some((l) => l.parentId === req.params.parentId)) throw httpError(404, "Not found");
    if (links.length <= 1) throw httpError(400, "A kid always needs at least one parent");
    db.delete(parentLinks)
      .where(and(eq(parentLinks.kidId, kid.id), eq(parentLinks.parentId, req.params.parentId)))
      .run();
    return userView(db, kid);
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const reader = requireAdmin(req);
    const target = loadVisibleUser(db, reader, req.params.id);
    if (target.id === reader.userId) throw httpError(400, "You can't delete yourself");
    // Deleting the only parent of a kid would leave them unlinked.
    const orphans = db
      .select({ kidId: parentLinks.kidId, n: sql<number>`(select count(*) from parent_links p2 where p2.kid_id = ${parentLinks.kidId})` })
      .from(parentLinks)
      .where(eq(parentLinks.parentId, target.id))
      .all()
      .filter((r) => r.n <= 1);
    if (orphans.length) throw httpError(400, "Link their kids to another parent first");
    db.delete(users).where(eq(users.id, target.id)).run();
    return { ok: true };
  });
}
