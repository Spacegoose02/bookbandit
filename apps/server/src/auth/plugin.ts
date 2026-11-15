/**
 * Authentication. Every request is resolved to at most one reader, in this order:
 *
 * 1. Session token (`Authorization: Bearer bbs_…` or the `bb_session` cookie), issued by
 *    password, PIN or picture sign-in. Wins over the proxy header so a kid can switch to their
 *    own profile on a parent's browser.
 * 2. Device token (`Authorization: Bearer bbd_…`, or the `bb_device` cookie in a tablet's browser)
 *    from QR pairing. A device locked to a person
 *    signs that person in; a shared family device only gets `req.device` (profile picker).
 * 3. Tinyauth (forward auth on the reverse proxy) email header, trusted only when the TCP peer
 *    is one of TRUSTED_PROXIES.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { devices, userIdentities, users } from "../db/schema.js";
import { toReader, type DeviceContext, type Reader } from "./reader.js";
import { ipMatches } from "./trusted-proxy.js";
import { DEVICE_COOKIE, readCookie, SESSION_COOKIE, SESSION_PREFIX, type SessionSigner } from "./sessions.js";
import { sha256 } from "./secrets.js";

export const DEVICE_TOKEN_PREFIX = "bbd_";
const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

export interface AuthOptions {
  db: Db;
  emailHeader: string;
  trustedProxies: string[];
  sessions: SessionSigner;
  /** A device unused for longer than this is treated as revoked (0 or undefined = never). */
  deviceIdleMs?: number;
}

export const authPlugin = fp(async (app: FastifyInstance, opts: AuthOptions) => {
  app.decorateRequest("reader", null);
  app.decorateRequest("device", null);
  app.decorateRequest("authVia", null);

  app.addHook("onRequest", async (req) => {
    resolve(req, opts);
  });
});

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() ?? null;
}

function resolve(req: FastifyRequest, opts: AuthOptions): void {
  const token = bearer(req);
  const sessionToken =
    token?.startsWith(SESSION_PREFIX) ? token : readCookie(req.headers.cookie, SESSION_COOKIE);

  if (sessionToken) {
    const r = fromSession(sessionToken, opts);
    if (r) {
      req.reader = r.reader;
      req.device = r.device;
      req.authVia = "session";
      return;
    }
  }

  const deviceToken = token?.startsWith(DEVICE_TOKEN_PREFIX)
    ? token
    : token
      ? null
      : readCookie(req.headers.cookie, DEVICE_COOKIE);
  if (deviceToken) {
    const device = deviceFromToken(deviceToken, opts.db, opts.deviceIdleMs);
    if (!device) return; // a bad device token never falls through to the proxy header
    req.device = device;
    if (device.userId) {
      const u = opts.db.select().from(users).where(eq(users.id, device.userId)).get();
      if (u && !u.disabled && u.householdId === device.householdId) {
        req.reader = toReader(u);
        req.authVia = "device";
      }
    }
    return;
  }

  const reader = fromProxyHeader(req, opts);
  if (reader) {
    req.reader = reader;
    req.authVia = "proxy";
  }
}

function fromSession(token: string, opts: AuthOptions): { reader: Reader; device: DeviceContext | null } | null {
  const p = opts.sessions.verify(token);
  if (!p) return null;
  const u = opts.db.select().from(users).where(eq(users.id, p.u)).get();
  if (!u || u.disabled || u.householdId !== p.h) return null;
  let device: DeviceContext | null = null;
  if (p.d) {
    const d = opts.db.select().from(devices).where(eq(devices.id, p.d)).get();
    if (!d || d.revokedAt != null || d.householdId !== u.householdId) return null;
    if (idleTooLong(d, opts.deviceIdleMs)) return null;
    touchDevice(opts.db, d);
    if (d.userId && d.userId !== u.id) return null;
    device = { id: d.id, householdId: d.householdId, familyId: d.familyId, userId: d.userId, name: d.name };
  }
  return { reader: toReader(u), device };
}

/** Record that a device was used (at most every few minutes, to keep writes down). */
function touchDevice(db: Db, d: { id: string; lastSeenAt: number | null }, now = Date.now()): void {
  if (!d.lastSeenAt || now - d.lastSeenAt > LAST_SEEN_THROTTLE_MS) {
    db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, d.id)).run();
  }
}

/** True when a paired device hasn't been used for longer than `idleMs`. */
function idleTooLong(d: { lastSeenAt: number | null; createdAt: number }, idleMs: number | undefined, now = Date.now()): boolean {
  return !!idleMs && now - (d.lastSeenAt ?? d.createdAt) > idleMs;
}

export function deviceFromToken(token: string, db: Db, idleMs?: number): DeviceContext | null {
  const d = db.select().from(devices).where(eq(devices.tokenHash, sha256(token))).get();
  if (!d || d.revokedAt != null) return null;
  const now = Date.now();
  if (idleTooLong(d, idleMs, now)) {
    // Expired from disuse: revoke it so the family's device list says so.
    db.update(devices).set({ revokedAt: now }).where(eq(devices.id, d.id)).run();
    return null;
  }
  touchDevice(db, d, now);
  return { id: d.id, householdId: d.householdId, familyId: d.familyId, userId: d.userId, name: d.name };
}

function fromProxyHeader(req: FastifyRequest, opts: AuthOptions): Reader | null {
  const peer = req.socket.remoteAddress ?? "";
  if (!ipMatches(peer, opts.trustedProxies)) return null;

  const raw = req.headers[opts.emailHeader.toLowerCase()];
  const email = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (!email) return null;

  const row = opts.db
    .select({ user: users })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(and(eq(userIdentities.provider, "tinyauth"), eq(userIdentities.subject, email)))
    .get();
  if (!row || row.user.disabled) return null;
  return toReader(row.user);
}

/** The caller's address: the proxy's X-Forwarded-For (last hop) when the peer is trusted, else the peer. */
export function clientIp(req: FastifyRequest, trustedProxies: string[]): string {
  const peer = req.socket.remoteAddress ?? "";
  if (!ipMatches(peer, trustedProxies)) return peer;
  const xff = req.headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.join(",") : xff)?.split(",").pop()?.trim();
  return last || peer;
}

/** True when the request came through a trusted proxy over HTTPS (or directly over HTTPS). */
export function isSecureRequest(req: FastifyRequest, trustedProxies: string[]): boolean {
  if (req.protocol === "https") return true;
  if (!ipMatches(req.socket.remoteAddress ?? "", trustedProxies)) return false;
  const proto = req.headers["x-forwarded-proto"];
  return (Array.isArray(proto) ? proto[0] : proto)?.split(",")[0]?.trim() === "https";
}

export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export function requireReader(req: FastifyRequest): Reader {
  if (!req.reader) throw httpError(401, "Sign in required");
  return req.reader;
}

export function requireAdmin(req: FastifyRequest): Reader {
  const reader = requireReader(req);
  if (reader.role !== "admin") throw httpError(403, "Admins only");
  return reader;
}
