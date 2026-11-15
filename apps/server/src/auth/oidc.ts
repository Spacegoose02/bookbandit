/**
 * Single sign-on with an OpenID Connect provider (made for Tinyauth, works with any OIDC server).
 *
 * Turned on by SSO_ISSUER + SSO_CLIENT_ID + SSO_CLIENT_SECRET + PUBLIC_URL. The flow is the plain
 * authorization-code flow with PKCE:
 *
 *   GET /api/auth/sso/start      → redirect to the provider, with state, nonce and PKCE kept in a
 *                                  short-lived signed cookie
 *   GET /auth/sso/callback       → swap the code for tokens, check the ID token (signature, issuer,
 *                                  audience, expiry, nonce), read the email, sign that person in
 *
 * The email is matched to someone under People (a "tinyauth" identity, the same one the
 * forward-auth header uses). An email nobody uses yet gets a new grown-up account with the
 * "adult" role (never admin or parent) when SSO_AUTO_CREATE is on, which is the default: the
 * provider's own allow list (Tinyauth's approved emails) decides who can get that far. An admin
 * can change the role on the People page afterwards. Errors land back on the sign-in screen as
 * `/?sso_error=<code>`.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { userIdentities, users } from "../db/schema.js";
import { httpError, isSecureRequest } from "./plugin.js";
import { userView } from "./view.js";
import { cookie, readCookie, sessionCookie, type SessionSigner } from "./sessions.js";

export interface SsoConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Bookbandit's own address as people reach it, e.g. https://books.example.com */
  publicUrl: string;
  /** Button text: "Sign in with <label>". */
  label: string;
  /** Make a new "adult" account for an email nobody uses yet (otherwise refuse it). */
  autoCreate: boolean;
}

export interface SsoOptions {
  db: Db;
  sessions: SessionSigner;
  trustedProxies: string[];
  sso: SsoConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const SSO_START_PATH = "/api/auth/sso/start";
export const SSO_CALLBACK_PATH = "/auth/sso/callback";
export const SSO_LINK_PATH = `${SSO_START_PATH}?link=1`;
const FLOW_COOKIE = "bb_sso";
const FLOW_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_S = 120;

export type SsoErrorCode = "expired" | "denied" | "provider" | "token" | "no_email" | "unlinked" | "disabled" | "device" | "setup" | "taken" | "link_signin";

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  token_endpoint_auth_methods_supported?: string[];
}

interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
  /** Set when linking: the signed-in person who asked, who gets the email instead of a sign-in. */
  link?: string;
}

/** Reads SSO settings from the environment. Returns null (SSO off) unless all four required values are set. */
export function ssoConfigFrom(env: {
  SSO_ISSUER?: string;
  SSO_CLIENT_ID?: string;
  SSO_CLIENT_SECRET?: string;
  PUBLIC_URL?: string;
  SSO_LABEL?: string;
  SSO_AUTO_CREATE?: boolean;
}): SsoConfig | null {
  const { SSO_ISSUER, SSO_CLIENT_ID, SSO_CLIENT_SECRET, PUBLIC_URL } = env;
  if (!SSO_ISSUER || !SSO_CLIENT_ID || !SSO_CLIENT_SECRET || !PUBLIC_URL) return null;
  return {
    issuer: SSO_ISSUER.replace(/\/+$/, ""),
    clientId: SSO_CLIENT_ID,
    clientSecret: SSO_CLIENT_SECRET,
    publicUrl: PUBLIC_URL.replace(/\/+$/, ""),
    label: env.SSO_LABEL?.trim() || "Tinyauth",
    autoCreate: env.SSO_AUTO_CREATE ?? true,
  };
}

const b64url = (b: Buffer) => b.toString("base64url");
const random = () => b64url(randomBytes(32));

export async function ssoRoutes(app: FastifyInstance, opts: SsoOptions) {
  const { db, sessions, sso } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const redirectUri = `${sso.publicUrl}${SSO_CALLBACK_PATH}`;

  let discovery: Promise<Discovery> | null = null;
  let jwks: { at: number; keys: (JsonWebKey & { kid?: string; alg?: string })[] } | null = null;

  async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(url, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return (await res.json()) as T;
  }

  function discover(): Promise<Discovery> {
    discovery ??= getJson<Discovery>(`${sso.issuer}/.well-known/openid-configuration`).then(
      (d) => {
        if (!d.authorization_endpoint || !d.token_endpoint) throw new Error("Provider discovery is missing endpoints");
        return d;
      },
      (e) => {
        discovery = null; // try again next time, e.g. Tinyauth was still starting
        throw e;
      },
    );
    return discovery;
  }

  async function signingKey(d: Discovery, kid: string | undefined, refresh: boolean) {
    if (!d.jwks_uri) return null;
    if (!jwks || refresh || now() - jwks.at > 60 * 60_000) {
      jwks = { at: now(), keys: (await getJson<{ keys: JsonWebKey[] }>(d.jwks_uri)).keys ?? [] };
    }
    return jwks.keys.find((k) => (kid ? k.kid === kid : true) && k.use !== "enc") ?? null;
  }

  /** Verifies an ID token's signature against the provider's published keys (RS256/384/512, ES256/384/512). */
  async function verifyIdToken(d: Discovery, token: string): Promise<Record<string, unknown>> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("ID token is not a JWT");
    const [h, p, s] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    const alg = header.alg ?? "";
    const hash = ({ RS256: "sha256", RS384: "sha384", RS512: "sha512", ES256: "sha256", ES384: "sha384", ES512: "sha512" } as Record<string, string>)[alg];
    if (!hash) throw new Error(`Unsupported ID token algorithm ${alg}`);
    let jwk = await signingKey(d, header.kid, false);
    if (!jwk) jwk = await signingKey(d, header.kid, true); // the provider may have rotated keys
    if (!jwk) throw new Error("No signing key for the ID token");
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const data = Buffer.from(`${h}.${p}`);
    const sig = Buffer.from(s, "base64url");
    const ok = alg.startsWith("ES")
      ? verifySignature(hash, data, { key, dsaEncoding: "ieee-p1363" }, sig)
      : verifySignature(hash, data, key, sig);
    if (!ok) throw new Error("ID token signature doesn't match");
    return claims;
  }

  /** A new grown-up ("adult", no admin rights) in the family, linked to this email. Null before first-run setup. */
  function createAccount(email: string, displayName: string) {
    return db.transaction((tx) => {
      const owner = tx.select().from(users).where(eq(users.role, "admin")).orderBy(asc(users.createdAt)).limit(1).get();
      if (!owner) return null;
      const taken = tx
        .select({ user: users })
        .from(userIdentities)
        .innerJoin(users, eq(users.id, userIdentities.userId))
        .where(and(eq(userIdentities.provider, "tinyauth"), eq(userIdentities.subject, email)))
        .get();
      if (taken) return taken.user;
      const [u] = tx.insert(users).values({ householdId: owner.householdId, displayName, role: "adult" }).returning().all();
      tx.insert(userIdentities).values({ userId: u!.id, provider: "tinyauth", subject: email }).run();
      return u!;
    });
  }

  const secure = (req: FastifyRequest) => isSecureRequest(req, opts.trustedProxies);

  function fail(reply: FastifyReply, req: FastifyRequest, code: SsoErrorCode, detail?: unknown, linking = false) {
    if (detail) req.log.warn({ err: detail }, `Single sign-on failed: ${code}`);
    reply.header("set-cookie", cookie(FLOW_COOKIE, "", 0, secure(req)));
    return reply.redirect(`${linking ? "/settings" : "/"}?sso_error=${code}`, 303);
  }

  /** Grown-ups (admins included) may link their own sign-ins; kids never change their own (rule 2). */
  const canLinkSelf = (req: FastifyRequest) => !!req.reader && req.reader.role !== "kid";

  app.get<{ Querystring: { link?: string } }>(SSO_START_PATH, async (req, reply) => {
    const linking = req.query.link === "1";
    if (linking && !canLinkSelf(req)) return fail(reply, req, "link_signin", undefined, true);
    let d: Discovery;
    try {
      d = await discover();
    } catch (e) {
      return fail(reply, req, "provider", e, linking);
    }
    const flow: Flow = {
      state: random(),
      nonce: random(),
      verifier: random(),
      exp: now() + FLOW_TTL_MS,
      ...(linking ? { link: req.reader!.userId } : {}),
    };
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: sso.clientId,
      redirect_uri: redirectUri,
      scope: "openid email profile",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: b64url(createHash("sha256").update(flow.verifier).digest()),
      code_challenge_method: "S256",
    }).toString();
    reply.header("set-cookie", cookie(FLOW_COOKIE, sessions.seal(flow), FLOW_TTL_MS, secure(req)));
    return reply.redirect(url.toString(), 302);
  });

  app.get<{ Querystring: Record<string, string | undefined> }>(SSO_CALLBACK_PATH, async (req, reply) => {
    const q = req.query;
    const raw = readCookie(req.headers.cookie, FLOW_COOKIE);
    const flow = raw ? sessions.unseal<Flow>(raw) : null;
    const linking = !!flow?.link;
    if (q.error) return fail(reply, req, "denied", `${q.error}: ${q.error_description ?? ""}`, linking);
    if (!flow || flow.exp < now() || !q.state || q.state !== flow.state || !q.code) return fail(reply, req, "expired", undefined, linking);

    let email: string | undefined;
    let name: string | undefined;
    try {
      const d = await discover();
      const form = new URLSearchParams({ grant_type: "authorization_code", code: q.code, redirect_uri: redirectUri, code_verifier: flow.verifier });
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
      const methods = d.token_endpoint_auth_methods_supported;
      if (!methods || methods.includes("client_secret_basic")) {
        const enc = (v: string) => encodeURIComponent(v);
        headers.authorization = `Basic ${Buffer.from(`${enc(sso.clientId)}:${enc(sso.clientSecret)}`).toString("base64")}`;
      } else {
        form.set("client_id", sso.clientId);
        form.set("client_secret", sso.clientSecret);
      }
      const tokens = await getJson<{ id_token?: string; access_token?: string }>(d.token_endpoint, { method: "POST", headers, body: form.toString() });
      if (!tokens.id_token) throw new Error("No ID token in the token response");
      const claims = await verifyIdToken(d, tokens.id_token);
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const t = now() / 1000;
      if (claims.iss !== d.issuer) throw new Error("ID token issuer doesn't match");
      if (!aud.includes(sso.clientId)) throw new Error("ID token is for another client");
      if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < t) throw new Error("ID token expired");
      if (claims.nonce !== flow.nonce) throw new Error("ID token nonce doesn't match");

      let profile: Record<string, unknown> = claims;
      if (typeof claims.email !== "string" && tokens.access_token && d.userinfo_endpoint) {
        const info = await getJson<Record<string, unknown>>(d.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } });
        if (info.sub === claims.sub) profile = info;
      }
      if (profile.email_verified === false) return fail(reply, req, "no_email", undefined, linking);
      email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : undefined;
      for (const k of ["name", "preferred_username", "given_name"]) {
        if (typeof profile[k] === "string" && (profile[k] as string).trim()) {
          name = (profile[k] as string).trim().slice(0, 60);
          break;
        }
      }
    } catch (e) {
      return fail(reply, req, "token", e, linking);
    }
    if (!email) return fail(reply, req, "no_email", undefined, linking);

    if (flow.link) {
      // Still the same person who pressed "Link" (their session cookie came back with them).
      if (!canLinkSelf(req) || req.reader!.userId !== flow.link) return fail(reply, req, "link_signin", undefined, true);
      const owner = db
        .select({ userId: userIdentities.userId })
        .from(userIdentities)
        .where(and(eq(userIdentities.provider, "tinyauth"), eq(userIdentities.subject, email)))
        .get();
      if (owner && owner.userId !== flow.link) {
        // The email already opens another account. If that's just the account single sign-on made
        // on its own (an "adult" with this email as its only sign-in), merge it into this one:
        // the email moves here and the leftover account is turned off, like People → Move to….
        const other = db.select().from(users).where(eq(users.id, owner.userId)).get()!;
        const otherLogins = db.select().from(userIdentities).where(eq(userIdentities.userId, other.id)).all();
        const throwaway = other.role === "adult" && !other.secretHash && otherLogins.length === 1 && other.householdId === req.reader!.householdId;
        if (!throwaway) return fail(reply, req, "taken", `${email} belongs to another account`, true);
        db.transaction((tx) => {
          tx.update(userIdentities).set({ userId: flow.link! }).where(eq(userIdentities.id, otherLogins[0]!.id)).run();
          tx.update(users).set({ disabled: true }).where(eq(users.id, other.id)).run();
        });
        req.log.info({ from: other.id, to: flow.link }, "Single sign-on email merged into an existing account");
      }
      if (!owner) db.insert(userIdentities).values({ userId: flow.link, provider: "tinyauth", subject: email }).run();
      reply.header("set-cookie", cookie(FLOW_COOKIE, "", 0, secure(req)));
      return reply.redirect("/settings?sso_linked=1", 303);
    }

    const row = db
      .select({ user: users })
      .from(userIdentities)
      .innerJoin(users, eq(users.id, userIdentities.userId))
      .where(and(eq(userIdentities.provider, "tinyauth"), eq(userIdentities.subject, email)))
      .get();
    let u = row?.user;
    if (!u) {
      if (!sso.autoCreate) return fail(reply, req, "unlinked", `no one is linked to ${email}`);
      const created = createAccount(email, name ?? email.split("@")[0]!.slice(0, 60));
      if (!created) return fail(reply, req, "setup");
      req.log.info({ userId: created.id }, "Single sign-on created a new account");
      u = created;
    }
    if (u.disabled) return fail(reply, req, "disabled");
    if (req.device?.userId && req.device.userId !== u.id) return fail(reply, req, "device");

    const { token, expiresAt } = sessions.issue({ u: u.id, h: u.householdId, d: req.device?.id ?? null, m: "sso" });
    reply.header("set-cookie", [cookie(FLOW_COOKIE, "", 0, secure(req)), sessionCookie(token, expiresAt - now(), secure(req))]);
    return reply.redirect("/", 303);
  });

  /** Unlink one of your own single sign-on emails, keeping at least one way to sign in. */
  app.delete<{ Params: { id: string } }>("/api/auth/sso/identities/:id", async (req) => {
    if (!req.reader) throw httpError(401, "Sign in required");
    if (!canLinkSelf(req)) throw httpError(403, "Ask a grown-up to change how you sign in");
    const me = db.select().from(users).where(eq(users.id, req.reader.userId)).get()!;
    const mine = db.select().from(userIdentities).where(eq(userIdentities.userId, me.id)).all();
    const target = mine.find((i) => i.id === req.params.id && i.provider === "tinyauth");
    if (!target) throw httpError(404, "Not found");
    const rest = mine.filter((i) => i.id !== target.id);
    const canStillSignIn = rest.some((i) => i.provider === "tinyauth") || (rest.some((i) => i.provider === "local") && !!me.secretHash);
    if (!canStillSignIn) throw httpError(400, "That's your only way to sign in. Set a password or link another email first.");
    db.delete(userIdentities).where(eq(userIdentities.id, target.id)).run();
    return userView(db, me);
  });
}
