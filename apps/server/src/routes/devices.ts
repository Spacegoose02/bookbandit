/**
 * Paired tablets and API clients.
 *
 * A parent or admin starts pairing and gets a one-time code (shown as a QR code and as text).
 * The tablet claims it within 10 minutes and gets a long-lived device token. A device can be
 * locked to one person (a kid's own tablet signs straight in as them) or shared by the family
 * (it shows the "Who's reading?" picker and kids sign in with their PIN or pictures).
 *
 * Pending pairings live in the devices table with `token_hash = "pair:" + sha256(code)` and no
 * `last_seen_at`; claiming swaps in the real token's hash. Device-token lookups use a plain
 * sha256 hex, so a pending pairing code can never be used as a token.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, isNull, like, lt, not } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { devices, users } from "../db/schema.js";
import { clientIp, DEVICE_TOKEN_PREFIX, httpError, isSecureRequest, requireReader } from "../auth/plugin.js";
import { canManage, loadManagedUser } from "../auth/permissions.js";
import { normalizePairingCode, pairingCode, randomToken, sha256 } from "../auth/secrets.js";
import { Lockout, TooManyAttemptsError } from "../auth/rate-limit.js";
import { useAuthErrors } from "../auth/errors.js";
import { cookie, DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE_MS } from "../auth/sessions.js";
import { canManageKids } from "@bookbandit/shared";
import type { Reader } from "../auth/reader.js";

export const PAIRING_TTL_MS = 10 * 60_000;
const PENDING = "pair:";

const name = z.string().trim().min(1).max(60);
const StartBody = z.object({ name, userId: z.string().uuid().nullable().optional() }).strict();
const ClaimBody = z.object({ code: z.string().min(4).max(32), name: name.optional() }).strict();
const PatchBody = z.object({ name: name.optional(), userId: z.string().uuid().nullable().optional() }).strict();

type DeviceRow = typeof devices.$inferSelect;

function deviceView(d: DeviceRow) {
  return {
    id: d.id,
    name: d.name,
    userId: d.userId,
    lastSeenAt: d.lastSeenAt,
    revokedAt: d.revokedAt,
    createdAt: d.createdAt,
  };
}

export async function deviceRoutes(
  app: FastifyInstance,
  opts: { db: Db; trustedProxies: string[]; claimLockout?: Lockout },
) {
  const { db } = opts;
  const claimLockout = opts.claimLockout ?? new Lockout({ freeTries: 10, baseLockMs: 60_000 });
  useAuthErrors(app);

  function requireManagerRole(reader: Reader) {
    if (!canManageKids(reader.role)) throw httpError(403, "Only a parent or admin can manage devices");
  }

  /** Who a device may be locked to: yourself, or someone you manage. */
  function checkLockTarget(reader: Reader, userId: string | null | undefined) {
    if (!userId || userId === reader.userId) return;
    loadManagedUser(db, reader, userId);
  }

  /** Parents see household devices that are shared, theirs, or locked to their kids. Admins see all. */
  function visibleTo(reader: Reader, d: DeviceRow): boolean {
    if (d.householdId !== reader.householdId) return false;
    if (reader.role === "admin" || !d.userId || d.userId === reader.userId) return true;
    const owner = db.select().from(users).where(eq(users.id, d.userId)).get();
    return !!owner && canManage(db, reader, owner);
  }

  function loadDevice(reader: Reader, id: string): DeviceRow {
    const d = db.select().from(devices).where(eq(devices.id, id)).get();
    if (!d || d.tokenHash.startsWith(PENDING) || !visibleTo(reader, d)) throw httpError(404, "Not found");
    return d;
  }

  const sweepExpired = () =>
    db
      .delete(devices)
      .where(
        and(like(devices.tokenHash, `${PENDING}%`), isNull(devices.lastSeenAt), lt(devices.createdAt, Date.now() - PAIRING_TTL_MS)),
      )
      .run();

  /** Start pairing: returns a one-time code and what to put in the QR code. */
  app.post("/api/devices/pairings", async (req, reply) => {
    const reader = requireReader(req);
    requireManagerRole(reader);
    const body = StartBody.parse(req.body);
    checkLockTarget(reader, body.userId);
    sweepExpired();

    const code = pairingCode();
    const now = Date.now();
    const [row] = db
      .insert(devices)
      .values({
        householdId: reader.householdId,
        userId: body.userId ?? null,
        name: body.name,
        tokenHash: PENDING + sha256(code),
        createdAt: now,
      })
      .returning()
      .all();

    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? req.protocol;
    const server = host ? `${proto}://${Array.isArray(host) ? host[0] : host}` : null;
    reply.status(201);
    return {
      pairingId: row!.id,
      code,
      expiresAt: now + PAIRING_TTL_MS,
      /** Encode this as the QR code. The app reads the server address and the code from it. */
      qr: `bookbandit://pair?${new URLSearchParams({ ...(server ? { server } : {}), code }).toString()}`,
    };
  });

  /** The tablet claims a code (no sign-in needed; the code is the proof). */
  app.post("/api/devices/claim", async (req, reply) => {
    const ipKey = `claim:${clientIp(req, opts.trustedProxies)}`;
    const wait = claimLockout.retryAfter(ipKey);
    if (wait > 0) throw new TooManyAttemptsError(wait);

    const body = ClaimBody.parse(req.body);
    const hash = PENDING + sha256(normalizePairingCode(body.code));
    const pending = db.select().from(devices).where(eq(devices.tokenHash, hash)).get();
    if (!pending || pending.lastSeenAt != null || pending.revokedAt != null || pending.createdAt < Date.now() - PAIRING_TTL_MS) {
      claimLockout.fail(ipKey);
      throw httpError(400, "That code didn't work. Ask a grown-up for a new one.");
    }

    const token = randomToken(DEVICE_TOKEN_PREFIX);
    const res = db
      .update(devices)
      .set({ tokenHash: sha256(token), lastSeenAt: Date.now(), ...(body.name ? { name: body.name } : {}) })
      .where(and(eq(devices.id, pending.id), eq(devices.tokenHash, hash)))
      .run();
    if (res.changes !== 1) throw httpError(400, "That code was already used");
    claimLockout.succeed(ipKey);

    const d = db.select().from(devices).where(eq(devices.id, pending.id)).get()!;
    // A browser on the tablet keeps it as a cookie; the Android app reads deviceToken instead.
    reply.header("set-cookie", cookie(DEVICE_COOKIE, token, DEVICE_COOKIE_MAX_AGE_MS, isSecureRequest(req, opts.trustedProxies)));
    reply.status(201);
    return { deviceToken: token, device: deviceView(d) };
  });

  /** What this request's device is (for the tablet's settings screen). */
  app.get("/api/devices/current", async (req) => {
    if (!req.device) throw httpError(404, "Not a paired device");
    const d = db.select().from(devices).where(eq(devices.id, req.device.id)).get()!;
    return deviceView(d);
  });

  app.get("/api/devices", async (req) => {
    const reader = requireReader(req);
    requireManagerRole(reader);
    const rows = db
      .select()
      .from(devices)
      .where(and(eq(devices.householdId, reader.householdId), not(like(devices.tokenHash, `${PENDING}%`))))
      .all()
      .filter((d) => visibleTo(reader, d));
    return { devices: rows.map(deviceView) };
  });

  app.patch<{ Params: { id: string } }>("/api/devices/:id", async (req) => {
    const reader = requireReader(req);
    requireManagerRole(reader);
    const body = PatchBody.parse(req.body);
    const d = loadDevice(reader, req.params.id);
    if (body.userId !== undefined) checkLockTarget(reader, body.userId);
    const patch: Partial<typeof devices.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.userId !== undefined) patch.userId = body.userId;
    if (Object.keys(patch).length) db.update(devices).set(patch).where(eq(devices.id, d.id)).run();
    return deviceView(db.select().from(devices).where(eq(devices.id, d.id)).get()!);
  });

  /** Revoke: the device token and every session signed in on it stop working at once. */
  app.delete<{ Params: { id: string } }>("/api/devices/:id", async (req) => {
    const reader = requireReader(req);
    requireManagerRole(reader);
    const d = loadDevice(reader, req.params.id);
    db.update(devices)
      .set({ revokedAt: Date.now() })
      .where(and(eq(devices.id, d.id), isNull(devices.revokedAt)))
      .run();
    return deviceView(db.select().from(devices).where(eq(devices.id, d.id)).get()!);
  });

}
