/**
 * Sign-in endpoints: first-run setup, local password, kid PIN / picture, profile picker, sign-out.
 * Google sign-in itself happens in Tinyauth in front of the app; nothing to do here for it.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  isValidPictureSequence,
  isValidPin,
  PASSWORD_MIN_LENGTH,
  PICTURE_SEQUENCE_LENGTH,
  PIN_LENGTH,
} from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { households, userIdentities, users } from "../db/schema.js";
import { clientIp, httpError, isSecureRequest } from "./plugin.js";
import { hashSecret, pictureSecret, verifySecret } from "./secrets.js";
import { sessionCookie, type SessionPayload, type SessionSigner } from "./sessions.js";
import { Lockout, TooManyAttemptsError } from "./rate-limit.js";
import { useAuthErrors } from "./errors.js";
import { ipMatches } from "./trusted-proxy.js";
import { profileCard, userView } from "./view.js";
import type { UserRow } from "./permissions.js";

export interface AuthRouteOptions {
  db: Db;
  sessions: SessionSigner;
  trustedProxies: string[];
  /** Per person (+ address for passwords). Exposed for tests. */
  lockout?: Lockout;
  /** Where the web app's "Sign in with Google" button points (Tinyauth login page). */
  googleSignInUrl?: string;
  /** Header the proxy sets with the signed-in email (to explain an unlinked Google account). */
  emailHeader?: string;
  /** Per account across all addresses, looser, so one bad actor can't lock a grown-up out for long. */
  accountLockout?: Lockout;
}

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{2,40}$/, "Use 2 to 40 letters, numbers, dots, dashes or underscores");
const password = z.string().min(PASSWORD_MIN_LENGTH).max(200);

const SetupBody = z
  .object({
    householdName: z.string().trim().min(1).max(80).default("Our family"),
    displayName: z.string().trim().min(1).max(60),
    email: z.string().trim().toLowerCase().email().optional(),
    username: username.optional(),
    password: password.optional(),
  })
  .refine((b) => b.email || (b.username && b.password), {
    message: "Give a Google email (for Tinyauth), or a username and password, or both",
  })
  .refine((b) => !b.username === !b.password, { message: "A username needs a password" });

const LoginBody = z
  .object({ username: username.optional(), userId: z.string().uuid().optional(), password: z.string().min(1).max(200) })
  .refine((b) => !!b.username !== !!b.userId, { message: "Give a username or a profile, not both" });

const KidSignInBody = z
  .object({
    userId: z.string().uuid(),
    pin: z.string().optional(),
    pictures: z.array(z.string()).optional(),
  })
  .refine((b) => !!b.pin !== !!b.pictures, { message: "Give a PIN or pictures" });

export async function authRoutes(app: FastifyInstance, opts: AuthRouteOptions) {
  const { db, sessions } = opts;
  const lockout = opts.lockout ?? new Lockout();
  const accountLockout = opts.accountLockout ?? new Lockout({ freeTries: 30, baseLockMs: 60_000, maxLockMs: 15 * 60_000 });

  const userCount = () => db.select({ n: sql<number>`count(*)` }).from(users).get()!.n;

  /** Household the request is acting within, from a signed-in reader or a paired device. */
  const householdContext = (req: FastifyRequest): string | null =>
    req.reader?.householdId ?? req.device?.householdId ?? null;

  function startSession(req: FastifyRequest, reply: FastifyReply, u: UserRow, method: SessionPayload["m"]) {
    if (req.device?.userId && req.device.userId !== u.id) {
      throw httpError(403, "This device belongs to someone else");
    }
    const { token, expiresAt } = sessions.issue({ u: u.id, h: u.householdId, d: req.device?.id ?? null, m: method });
    // Browsers use the HttpOnly cookie (it also covers <img> covers and file downloads);
    // apps send `token` back as a Bearer token.
    reply.header("set-cookie", sessionCookie(token, expiresAt - Date.now(), isSecureRequest(req, opts.trustedProxies)));
    return { token, expiresAt, user: userView(db, u) };
  }

  function guard(key: string) {
    const wait = lockout.retryAfter(key);
    if (wait > 0) throw new TooManyAttemptsError(wait);
  }

  useAuthErrors(app);

  function proxyEmail(req: FastifyRequest): string | null {
    if (!opts.emailHeader || !ipMatches(req.socket.remoteAddress ?? "", opts.trustedProxies)) return null;
    const raw = req.headers[opts.emailHeader.toLowerCase()];
    return (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase() || null;
  }

  app.get("/api/auth/status", async (req) => ({
    setupRequired: userCount() === 0,
    signedIn: !!req.reader,
    via: req.authVia,
    user: req.reader ? userView(db, db.select().from(users).where(eq(users.id, req.reader.userId)).get()!) : null,
    device: req.device ? { id: req.device.id, name: req.device.name, lockedTo: req.device.userId } : null,
    google: opts.googleSignInUrl ? { url: opts.googleSignInUrl } : null,
    /** Signed in to Google through the proxy, but no one here has that email yet. */
    unlinkedEmail: req.reader ? null : proxyEmail(req),
    limits: { pin: PIN_LENGTH, pictures: PICTURE_SEQUENCE_LENGTH, passwordMin: PASSWORD_MIN_LENGTH },
  }));

  /** First run only: create the household and its first admin. */
  app.post("/api/auth/setup", async (req, reply) => {
    const body = SetupBody.parse(req.body);
    const secretHash = body.password ? await hashSecret(body.password) : null;
    const created = db.transaction((tx) => {
      if (tx.select({ n: sql<number>`count(*)` }).from(users).get()!.n > 0) return null;
      const [home] = tx.insert(households).values({ name: body.householdName }).returning().all();
      const [admin] = tx
        .insert(users)
        .values({ householdId: home!.id, displayName: body.displayName, role: "admin", secretHash })
        .returning()
        .all();
      if (body.email) tx.insert(userIdentities).values({ userId: admin!.id, provider: "tinyauth", subject: body.email }).run();
      if (body.username) tx.insert(userIdentities).values({ userId: admin!.id, provider: "local", subject: body.username }).run();
      return admin!;
    });
    if (!created) throw httpError(409, "Already set up");
    reply.status(201);
    return body.username ? startSession(req, reply, created, "password") : { user: userView(db, created) };
  });

  /** Local password sign-in: by username anywhere, or by profile id from the picker. */
  app.post("/api/auth/login", async (req, reply) => {
    const body = LoginBody.parse(req.body);
    let u: UserRow | undefined;
    if (body.username) {
      u = db
        .select({ user: users })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(and(eq(userIdentities.provider, "local"), eq(userIdentities.subject, body.username)))
        .get()?.user;
    } else {
      const home = householdContext(req);
      if (!home) throw httpError(401, "Sign in with your username");
      const candidate = db.select().from(users).where(eq(users.id, body.userId!)).get();
      u = candidate?.householdId === home ? candidate : undefined;
    }
    const ip = clientIp(req, opts.trustedProxies);
    const key = `login:${body.username ?? body.userId}:${ip}`;
    guard(key);
    if (u) {
      const wait = accountLockout.retryAfter(`account:${u.id}`);
      if (wait > 0) throw new TooManyAttemptsError(wait);
    }
    // Kids sign in with a PIN or pictures, never a password.
    const usable = u && !u.disabled && u.role !== "kid";
    const ok = await verifySecret(body.password, usable ? u!.secretHash : null);
    if (!ok || !u || !usable) {
      lockout.fail(key);
      if (u) accountLockout.fail(`account:${u.id}`);
      throw httpError(401, "Wrong username or password");
    }
    lockout.succeed(key);
    accountLockout.succeed(`account:${u.id}`);
    return startSession(req, reply, u, "password");
  });

  /**
   * Profiles to show on the "Who's reading?" screen. Only on a paired family device or for someone
   * already signed in to the household, so names never leak to the open internet.
   */
  app.get("/api/auth/profiles", async (req) => {
    const home = householdContext(req);
    if (!home) throw httpError(401, "Sign in required");
    const rows = db
      .select()
      .from(users)
      .where(and(eq(users.householdId, home), eq(users.disabled, false)))
      .orderBy(users.displayName)
      .all();
    const visible = req.device?.userId ? rows.filter((r) => r.id === req.device!.userId) : rows;
    return { profiles: visible.map((u) => profileCard(db, u)) };
  });

  /** Kid sign-in with a PIN or a picture sequence, from the profile picker. */
  app.post("/api/auth/kid-sign-in", async (req, reply) => {
    const body = KidSignInBody.parse(req.body);
    const home = householdContext(req);
    if (!home) throw httpError(401, "Use a paired tablet, or have a grown-up sign in first");
    const key = `user:${body.userId}`;
    guard(key);
    const u = db
      .select()
      .from(users)
      .where(and(eq(users.id, body.userId), eq(users.householdId, home), eq(users.role, "kid"), ne(users.disabled, true)))
      .get();
    const method = body.pin != null ? "pin" : "picture";
    let secret: string | null = null;
    if (method === "pin" && isValidPin(body.pin!)) secret = body.pin!;
    if (method === "picture" && isValidPictureSequence(body.pictures!)) secret = pictureSecret(body.pictures!);
    const usable = !!u && u.kidSignInMethod === method && !!secret;
    const ok = await verifySecret(secret ?? "-", usable ? u!.secretHash : null);
    if (!ok || !u) {
      lockout.fail(key);
      throw httpError(401, method === "pin" ? "That PIN isn't right. Try again!" : "Those pictures aren't right. Try again!");
    }
    lockout.succeed(key);
    return startSession(req, reply, u, method);
  });

  app.post("/api/auth/sign-out", async (req, reply) => {
    reply.header("set-cookie", sessionCookie("", 0, isSecureRequest(req, opts.trustedProxies)));
    return { ok: true };
  });
}
