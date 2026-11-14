/**
 * Managing e-reader sign-ins (`/api/ereader/credentials`).
 *
 * Adults create and revoke their own. A parent does it for their linked kids, an admin for
 * anyone in the household. Kids can see theirs but never create or revoke one: a credential
 * is a way to sign in, and only a parent or admin changes how a kid signs in.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { httpError, requireReader } from "../auth/plugin.js";
import { canManage, loadManagedUser } from "../auth/permissions.js";
import { useAuthErrors } from "../auth/errors.js";
import type { Reader } from "../auth/reader.js";
import { sha256 } from "../auth/secrets.js";
import { ereaderCredentials, EREADER_CREDENTIAL_KINDS } from "./schema.js";
import {
  generateKoboToken,
  generatePassword,
  loginSecretHash,
  normalizeUsername,
  suggestUsername,
  USERNAME_RE,
  type CredentialRow,
} from "./credentials.js";

const CreateBody = z
  .object({
    kind: z.enum(EREADER_CREDENTIAL_KINDS),
    name: z.string().trim().min(1).max(60),
    /** Defaults to yourself. A parent may pass a linked kid; an admin anyone in the household. */
    userId: z.string().uuid().optional(),
    /** `login` only. Defaults to one made from the person's name. */
    username: z
      .string()
      .transform(normalizeUsername)
      .refine((u) => USERNAME_RE.test(u), "3 to 32 letters, digits, dots, dashes or underscores")
      .optional(),
  })
  .strict();

export function credentialView(c: CredentialRow) {
  return {
    id: c.id,
    userId: c.userId,
    kind: c.kind,
    name: c.name,
    username: c.username,
    createdAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
    revokedAt: c.revokedAt,
  };
}

/** The address the e-reader should use, from the request (as the reverse proxy forwarded it). */
export function publicBaseUrl(req: FastifyRequest): string {
  const fwdHost = req.headers["x-forwarded-host"];
  const host = (Array.isArray(fwdHost) ? fwdHost[0] : fwdHost) ?? req.headers.host ?? "localhost";
  const fwdProto = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(fwdProto) ? fwdProto[0] : fwdProto)?.split(",")[0]?.trim() || req.protocol;
  return `${proto}://${host.split(",")[0]!.trim()}`;
}

export async function ereaderCredentialRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  useAuthErrors(app);

  function requireNotKid(reader: Reader) {
    if (reader.role === "kid") throw httpError(403, "Ask a parent to set up your e-reader");
  }

  /** Your own credentials, plus those of everyone you manage. */
  app.get("/api/ereader/credentials", async (req) => {
    const reader = requireReader(req);
    const household = db.select().from(users).where(eq(users.householdId, reader.householdId)).all();
    const visibleIds = household.filter((u) => u.id === reader.userId || canManage(db, reader, u)).map((u) => u.id);
    const rows = db
      .select()
      .from(ereaderCredentials)
      .where(and(inArray(ereaderCredentials.userId, visibleIds), isNull(ereaderCredentials.revokedAt)))
      .orderBy(desc(ereaderCredentials.createdAt))
      .all();
    const base = publicBaseUrl(req);
    return {
      credentials: rows.map(credentialView),
      setup: { opdsUrl: `${base}/opds`, kosyncUrl: `${base}/kosync` },
    };
  });

  /** Create one. The password or Kobo token is in this reply only. */
  app.post("/api/ereader/credentials", async (req, reply) => {
    const reader = requireReader(req);
    requireNotKid(reader);
    const body = CreateBody.parse(req.body);
    const target =
      !body.userId || body.userId === reader.userId
        ? db.select().from(users).where(eq(users.id, reader.userId)).get()!
        : loadManagedUser(db, reader, body.userId);

    const base = publicBaseUrl(req);
    let username: string | null = null;
    let secret: string;
    let secretHash: string;
    if (body.kind === "login") {
      username = body.username ?? suggestUsername(target.displayName);
      const taken = db.select().from(ereaderCredentials).where(eq(ereaderCredentials.username, username)).get();
      if (taken) throw httpError(409, "That username is taken");
      secret = generatePassword();
      secretHash = loginSecretHash(secret);
    } else {
      if (body.username) throw httpError(400, "Kobo sign-ins don't have a username");
      secret = generateKoboToken();
      secretHash = sha256(secret);
    }

    const [row] = db
      .insert(ereaderCredentials)
      .values({
        householdId: target.householdId,
        userId: target.id,
        kind: body.kind,
        name: body.name,
        username,
        secretHash,
        createdBy: reader.userId,
        createdAt: Date.now(),
      })
      .returning()
      .all();

    reply.status(201);
    if (body.kind === "login") {
      return {
        credential: credentialView(row!),
        username,
        password: secret,
        setup: { opdsUrl: `${base}/opds`, kosyncUrl: `${base}/kosync` },
      };
    }
    return {
      credential: credentialView(row!),
      token: secret,
      /** Put this in `.kobo/Kobo/Kobo eReader.conf` as `api_endpoint=`. */
      koboApiEndpoint: `${base}/kobo/${secret}`,
    };
  });

  app.delete<{ Params: { id: string } }>("/api/ereader/credentials/:id", async (req) => {
    const reader = requireReader(req);
    requireNotKid(reader);
    const row = db.select().from(ereaderCredentials).where(eq(ereaderCredentials.id, req.params.id)).get();
    if (!row || row.householdId !== reader.householdId) throw httpError(404, "Not found");
    if (row.userId !== reader.userId) loadManagedUser(db, reader, row.userId);
    db.update(ereaderCredentials)
      .set({ revokedAt: Date.now() })
      .where(and(eq(ereaderCredentials.id, row.id), isNull(ereaderCredentials.revokedAt)))
      .run();
    return credentialView(db.select().from(ereaderCredentials).where(eq(ereaderCredentials.id, row.id)).get()!);
  });
}
