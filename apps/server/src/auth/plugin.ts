/**
 * Authentication.
 *
 * - Web: Tinyauth (forward auth on the reverse proxy) sets an email header.
 *   We only trust it when the TCP peer is a configured trusted proxy.
 * - Tablets / API clients: `Authorization: Bearer <device token>` (QR pairing; see devices table).
 *   TODO(auth workstream): device tokens, kid PIN / picture sign-in, profile switching.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { userIdentities, users } from "../db/schema.js";
import type { Reader } from "./reader.js";
import { ipMatches } from "./trusted-proxy.js";

export interface AuthOptions {
  db: Db;
  emailHeader: string;
  trustedProxies: string[];
}

export const authPlugin = fp(async (app: FastifyInstance, opts: AuthOptions) => {
  app.decorateRequest("reader", null);

  app.addHook("onRequest", async (req) => {
    req.reader = await resolveReader(req, opts);
  });
});

async function resolveReader(req: FastifyRequest, opts: AuthOptions): Promise<Reader | null> {
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

  const u = row.user;
  return {
    userId: u.id,
    householdId: u.householdId,
    role: u.role,
    displayName: u.displayName,
    birthYear: u.birthYear,
    isKid: u.role === "kid",
    explicitOptIn: u.role === "kid" ? false : u.explicitOptIn,
  };
}

export function requireReader(req: FastifyRequest): Reader {
  if (!req.reader) {
    const err = new Error("Sign in required") as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  return req.reader;
}

export function requireAdmin(req: FastifyRequest): Reader {
  const reader = requireReader(req);
  if (reader.role !== "admin") {
    const err = new Error("Admins only") as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  }
  return reader;
}
