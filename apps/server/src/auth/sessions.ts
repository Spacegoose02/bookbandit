/**
 * Session tokens, issued after password, PIN or picture sign-in.
 *
 * Stateless and HMAC-signed so no extra table is needed. A session stays valid only while
 * its user is enabled, and (when bound to a paired device) while that device isn't revoked;
 * both are checked on every request.
 *
 * Format: `bbs_<base64url(json payload)>.<base64url(hmac-sha256)>`
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

export const SESSION_PREFIX = "bbs_";
export const SESSION_COOKIE = "bb_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  /** user id */
  u: string;
  /** household id */
  h: string;
  /** paired device id this session is bound to, if signed in on one */
  d: string | null;
  /** how they signed in */
  m: "password" | "pin" | "picture" | "sso";
  iat: number;
  exp: number;
}

const SECRET_KEY = "auth.sessionSecret";

/** The HMAC key: SESSION_SECRET if set, otherwise one generated once and kept in settings. */
export function loadSessionSecret(db: Db, fromEnv: string | undefined): Buffer {
  if (fromEnv) return Buffer.from(fromEnv, "utf8");
  const row = db.select().from(settings).where(eq(settings.key, SECRET_KEY)).get();
  if (row && typeof row.value === "string") return Buffer.from(row.value, "base64url");
  const fresh = randomBytes(32).toString("base64url");
  db.insert(settings)
    .values({ key: SECRET_KEY, value: fresh, updatedAt: Date.now() })
    .onConflictDoNothing()
    .run();
  const stored = db.select().from(settings).where(eq(settings.key, SECRET_KEY)).get();
  return Buffer.from(stored!.value as string, "base64url");
}

export class SessionSigner {
  constructor(private readonly key: Buffer) {}

  issue(p: Omit<SessionPayload, "iat" | "exp">, now = Date.now(), ttlMs = SESSION_TTL_MS): { token: string; expiresAt: number } {
    const payload: SessionPayload = { ...p, iat: now, exp: now + ttlMs };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return { token: `${SESSION_PREFIX}${body}.${this.sign(body)}`, expiresAt: payload.exp };
  }

  verify(token: string, now = Date.now()): SessionPayload | null {
    if (!token.startsWith(SESSION_PREFIX)) return null;
    const [body, sig] = token.slice(SESSION_PREFIX.length).split(".");
    if (!body || !sig) return null;
    const expected = Buffer.from(this.sign(body), "base64url");
    const given = Buffer.from(sig, "base64url");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
      if (typeof p.u !== "string" || typeof p.exp !== "number" || p.exp <= now) return null;
      return p;
    } catch {
      return null;
    }
  }

  /** Signs any small JSON value (used for the single sign-on round trip's state cookie). */
  seal(value: unknown): string {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${body}.${this.sign(`seal:${body}`)}`;
  }

  /** The value `seal` signed, or null when the signature doesn't match. */
  unseal<T>(sealed: string): T | null {
    const [body, sig] = sealed.split(".");
    if (!body || !sig) return null;
    const expected = Buffer.from(this.sign(`seal:${body}`), "base64url");
    const given = Buffer.from(sig, "base64url");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  return cookie(SESSION_COOKIE, token, maxAgeMs, secure);
}

/** Browsers on a paired tablet keep the device token in this cookie (apps send it as a Bearer token). */
export const DEVICE_COOKIE = "bb_device";
/** Browsers cap cookie lifetime at about 400 days. */
export const DEVICE_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

export function cookie(name: string, value: string, maxAgeMs: number, secure: boolean): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
