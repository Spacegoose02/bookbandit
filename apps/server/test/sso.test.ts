import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { family, type Family } from "./helpers.js";
import { userIdentities, users } from "../src/db/schema.js";

const ISSUER = "https://auth.example.com";
const SITE = "https://books.example.com";
const ENV = {
  PUBLIC_URL: SITE,
  SSO_ISSUER: ISSUER,
  SSO_CLIENT_ID: "bookbandit",
  SSO_CLIENT_SECRET: "s3cret",
  SSO_LABEL: "Tinyauth",
};

/** A tiny OIDC provider: discovery, JWKS, and a token endpoint that signs whatever claims a test sets. */
function provider() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const state = {
    email: "dad@example.com" as string | undefined,
    name: "Dad Again",
    emailVerified: true as boolean | undefined,
    nonce: "",
    aud: "bookbandit",
    signWith: privateKey as KeyObject,
    tokenCalls: [] as { auth?: string; body: URLSearchParams }[],
  };
  const sign = (claims: Record<string, unknown>) => {
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(state.signWith).toString("base64url");
    return `${h}.${p}.${s}`;
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (url === `${ISSUER}/.well-known/openid-configuration`)
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/api/oidc/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      });
    if (url === `${ISSUER}/.well-known/jwks.json`)
      return json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" }] });
    if (url === `${ISSUER}/api/oidc/token`) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      state.tokenCalls.push({ auth: headers.authorization, body: new URLSearchParams(String(init?.body)) });
      const now = Math.floor(Date.now() / 1000);
      return json({
        access_token: "at",
        id_token: sign({
          iss: ISSUER,
          aud: state.aud,
          sub: "u1",
          exp: now + 300,
          iat: now,
          nonce: state.nonce,
          name: state.name,
          ...(state.email ? { email: state.email } : {}),
          ...(state.emailVerified === undefined ? {} : { email_verified: state.emailVerified }),
        }),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { state, fetchImpl };
}

let f: Family;
afterEach(async () => {
  await f?.close();
});

const cookieOf = (setCookie: string | string[] | undefined, name: string) =>
  ([] as string[])
    .concat(setCookie ?? [])
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${name}=`));

/** Runs the whole round trip and returns the callback response. */
async function signIn(p: ReturnType<typeof provider>, tamper: { state?: string } = {}) {
  const start = await f.app.inject({ method: "GET", url: "/api/auth/sso/start" });
  expect(start.statusCode).toBe(302);
  const to = new URL(start.headers.location as string);
  expect(to.origin + to.pathname).toBe(`${ISSUER}/authorize`);
  expect(to.searchParams.get("redirect_uri")).toBe(`${SITE}/auth/sso/callback`);
  expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  p.state.nonce = to.searchParams.get("nonce")!;
  const flow = cookieOf(start.headers["set-cookie"], "bb_sso")!;
  const state = tamper.state ?? to.searchParams.get("state")!;
  return f.app.inject({ method: "GET", url: `/auth/sso/callback?code=abc&state=${state}`, headers: { cookie: flow } });
}

async function whoAmI(res: { headers: Record<string, unknown> }) {
  const session = cookieOf(res.headers["set-cookie"] as string[], "bb_session");
  expect(session).toBeTruthy();
  const status = await f.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie: session! } });
  return status.json().user as { id: string; displayName: string; role: string } | null;
}

describe("single sign-on (OIDC)", () => {
  it("is off without the env vars, and the status says so", async () => {
    f = await family();
    expect((await f.app.inject({ method: "GET", url: "/api/auth/status" })).json().sso).toBeNull();
    expect((await f.app.inject({ method: "GET", url: "/api/auth/sso/start" })).statusCode).not.toBe(302);
  });

  it("signs an existing person in when the email matches, admin included", async () => {
    const p = provider();
    f = await family({ sso: { fetchImpl: p.fetchImpl } }, ENV);
    expect((await f.app.inject({ method: "GET", url: "/api/auth/status" })).json().sso).toEqual({
      label: "Tinyauth",
      url: "/api/auth/sso/start",
    });

    const res = await signIn(p);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/");
    expect((await whoAmI(res))?.id).toBe(f.ids.parent);
    expect(p.state.tokenCalls[0]!.auth).toMatch(/^Basic /);
    expect(p.state.tokenCalls[0]!.body.get("code_verifier")).toBeTruthy();

    p.state.email = "ADMIN@example.com";
    const admin = await signIn(p);
    expect((await whoAmI(admin))?.id).toBe(f.ids.admin);
  });

  it("creates an adult account (never admin) for a new email, once", async () => {
    const p = provider();
    f = await family({ sso: { fetchImpl: p.fetchImpl } }, ENV);
    p.state.email = "grandma@example.com";
    p.state.name = "Grandma";
    const first = await whoAmI(await signIn(p));
    expect(first).toMatchObject({ displayName: "Grandma", role: "adult" });
    const again = await whoAmI(await signIn(p));
    expect(again?.id).toBe(first!.id);
    const links = f.db.select().from(userIdentities).where(eq(userIdentities.subject, "grandma@example.com")).all();
    expect(links).toHaveLength(1);
  });

  it("refuses new emails when SSO_AUTO_CREATE=false", async () => {
    const p = provider();
    f = await family({ sso: { fetchImpl: p.fetchImpl } }, { ...ENV, SSO_AUTO_CREATE: "false" });
    p.state.email = "stranger@example.com";
    const res = await signIn(p);
    expect(res.headers.location).toBe("/?sso_error=unlinked");
    expect(cookieOf(res.headers["set-cookie"], "bb_session")).toBeUndefined();
  });

  it("refuses a wrong state, a token for another client and a forged signature", async () => {
    const p = provider();
    f = await family({ sso: { fetchImpl: p.fetchImpl } }, ENV);

    expect((await signIn(p, { state: "nope" })).headers.location).toBe("/?sso_error=expired");

    p.state.aud = "someone-else";
    expect((await signIn(p)).headers.location).toBe("/?sso_error=token");
    p.state.aud = "bookbandit";

    p.state.signWith = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect((await signIn(p)).headers.location).toBe("/?sso_error=token");
  });

  it("refuses a disabled person and an unverified email", async () => {
    const p = provider();
    f = await family({ sso: { fetchImpl: p.fetchImpl } }, ENV);
    p.state.emailVerified = false;
    expect((await signIn(p)).headers.location).toBe("/?sso_error=no_email");
    p.state.emailVerified = true;
    f.db.update(users).set({ disabled: true }).where(eq(users.id, f.ids.parent)).run();
    expect((await signIn(p)).headers.location).toBe("/?sso_error=disabled");
  });

  it("needs the start cookie (no callback without a started sign-in)", async () => {
    const p = provider();
    f = await family({ sso: { fetchImpl: p.fetchImpl } }, ENV);
    const res = await f.app.inject({ method: "GET", url: "/auth/sso/callback?code=abc&state=x" });
    expect(res.headers.location).toBe("/?sso_error=expired");
  });
});

describe("linking sign-in emails on People", () => {
  it("lets an admin link an email to an existing grown-up and move one from an SSO-made account", async () => {
    const p = provider();
    f = await family({ sso: { fetchImpl: p.fetchImpl } }, ENV);
    const linked = await f.app.inject({
      method: "POST",
      url: `/api/users/${f.ids.adult}/identities`,
      headers: f.as("admin"),
      payload: { provider: "tinyauth", subject: "aunt@gmail.com" },
    });
    expect(linked.statusCode).toBe(201);

    // Uncle signs in with SSO before anyone set him up: a separate account appears.
    p.state.email = "uncle@gmail.com";
    p.state.name = "Uncle Bob";
    const made = (await whoAmI(await signIn(p)))!;
    const identity = f.db.select().from(userIdentities).where(eq(userIdentities.subject, "uncle@gmail.com")).get()!;

    // Not for non-admins.
    const denied = await f.app.inject({
      method: "POST",
      url: `/api/users/${made.id}/identities/${identity.id}/move`,
      headers: f.as("parent"),
      payload: { toUserId: f.ids.parent },
    });
    expect(denied.statusCode).toBe(403);

    // The admin merges that email into Dad's profile.
    const moved = await f.app.inject({
      method: "POST",
      url: `/api/users/${made.id}/identities/${identity.id}/move`,
      headers: f.as("admin"),
      payload: { toUserId: f.ids.parent },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().from.disabled).toBe(true);
    expect(moved.json().to.identities.map((i: { subject: string }) => i.subject)).toContain("uncle@gmail.com");

    expect((await whoAmI(await signIn(p)))?.id).toBe(f.ids.parent);
  });

  it("doesn't let a non-admin link an email to someone else", async () => {
    f = await family();
    const res = await f.app.inject({
      method: "POST",
      url: `/api/users/${f.ids.adult}/identities`,
      headers: f.as("parent"),
      payload: { provider: "tinyauth", subject: "x@example.com" },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});
