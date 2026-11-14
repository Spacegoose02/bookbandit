import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { loadConfig } from "../src/config.js";
import { books, households, parentLinks, userIdentities, users } from "../src/db/schema.js";
import { hashSecret } from "../src/auth/secrets.js";

let app: FastifyInstance;
let db: Db;
let close: () => void;
let ids: { home: string; dad: string; mom: string; aunt: string; emma: string; admin: string };

const kidBirthYear = new Date().getUTCFullYear() - 8; // 7 by our conservative age rule

beforeEach(async () => {
  ({ db, close } = openDb(":memory:"));
  const [home] = db.insert(households).values({ name: "Home" }).returning().all();
  const mk = (displayName: string, role: "admin" | "parent" | "adult" | "kid", extra: Partial<typeof users.$inferInsert> = {}) =>
    db.insert(users).values({ householdId: home!.id, displayName, role, ...extra }).returning().all()[0]!;
  const admin = mk("Admin", "admin", { secretHash: await hashSecret("admin-password") });
  const dad = mk("Dad", "parent");
  const mom = mk("Mom", "parent");
  const aunt = mk("Aunt", "adult");
  const emma = mk("Emma", "kid", { birthYear: kidBirthYear, kidSignInMethod: "pin", secretHash: await hashSecret("1234") });
  db.insert(parentLinks).values({ parentId: dad.id, kidId: emma.id }).run();
  db.insert(userIdentities)
    .values([
      { userId: admin.id, provider: "local", subject: "admin" },
      { userId: dad.id, provider: "tinyauth", subject: "dad@example.com" },
      { userId: mom.id, provider: "tinyauth", subject: "mom@example.com" },
      { userId: aunt.id, provider: "tinyauth", subject: "aunt@example.com" },
    ])
    .run();
  db.insert(books)
    .values([
      { title: "Picture Book", sortTitle: "picture book", rating: "kids", approved: true },
      { title: "Thriller", sortTitle: "thriller", rating: "adult", approved: true },
    ])
    .run();
  ids = { home: home!.id, dad: dad.id, mom: mom.id, aunt: aunt.id, emma: emma.id, admin: admin.id };

  const config = loadConfig({ TRUSTED_PROXIES: "127.0.0.1", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  app = await buildApp(config, db);
});

afterEach(async () => {
  await app.close();
  close();
});

const as = (email: string) => ({ "remote-email": email });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const call = (o: InjectOptions) => app.inject(o);
const titles = async (headers: Record<string, string>) => {
  const res = await call({ method: "GET", url: "/api/books", headers });
  expect(res.statusCode).toBe(200);
  return (res.json().items as { title: string }[]).map((b) => b.title).sort();
};

async function pairDevice(by: string, body: Record<string, unknown>) {
  const start = await call({ method: "POST", url: "/api/devices/pairings", headers: as(by), payload: body });
  expect(start.statusCode).toBe(201);
  const { code, qr } = start.json();
  expect(qr).toContain("bookbandit://pair?");
  const claim = await call({ method: "POST", url: "/api/devices/claim", payload: { code: code.toLowerCase().replace("-", " ") } });
  expect(claim.statusCode).toBe(201);
  return { code: code as string, token: claim.json().deviceToken as string, device: claim.json().device };
}

describe("first-run setup", () => {
  it("is refused once anyone exists", async () => {
    const res = await call({
      method: "POST",
      url: "/api/auth/setup",
      payload: { displayName: "Intruder", username: "boss", password: "password123" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("creates the first admin on an empty install and signs them in", async () => {
    await app.close();
    close();
    ({ db, close } = openDb(":memory:"));
    app = await buildApp(loadConfig({ LOG_LEVEL: "error" } as NodeJS.ProcessEnv), db);
    const status = await call({ method: "GET", url: "/api/auth/status" });
    expect(status.json().setupRequired).toBe(true);
    const res = await call({
      method: "POST",
      url: "/api/auth/setup",
      payload: { displayName: "Sam", username: "sam", password: "password123", email: "Sam@Example.com" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.role).toBe("admin");
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    const me = await call({ method: "GET", url: "/api/users/me", headers: { cookie } });
    expect(me.json().identities.map((i: { subject: string }) => i.subject).sort()).toEqual(["sam", "sam@example.com"]);
  });
});

describe("local password sign-in", () => {
  it("issues a session that works as a bearer token and a cookie", async () => {
    const res = await call({ method: "POST", url: "/api/auth/login", payload: { username: "ADMIN", password: "admin-password" } });
    expect(res.statusCode).toBe(200);
    const { token } = res.json();
    expect(String(res.headers["set-cookie"])).toContain("HttpOnly");
    expect((await call({ method: "GET", url: "/api/users/me", headers: bearer(token) })).json().role).toBe("admin");
    const signOut = await call({ method: "POST", url: "/api/auth/sign-out" });
    expect(String(signOut.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("locks out after repeated wrong passwords", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await call({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "nope-nope" } });
      expect(r.statusCode).toBe(401);
    }
    const locked = await call({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin-password" } });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBeDefined();
  });

  it("rejects a forged or tampered session token", async () => {
    const res = await call({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin-password" } });
    const token: string = res.json().token;
    const [body, sig] = token.slice(4).split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
    const forged = `bbs_${Buffer.from(JSON.stringify({ ...payload, u: ids.emma })).toString("base64url")}.${sig}`;
    expect((await call({ method: "GET", url: "/api/users/me", headers: bearer(forged) })).statusCode).toBe(401);
  });
});

describe("kid accounts", () => {
  it("a parent adds a kid, who is linked to them and gets picture sign-in", async () => {
    const res = await call({
      method: "POST",
      url: "/api/users",
      headers: as("dad@example.com"),
      payload: { displayName: "Leo", role: "kid", birthYear: kidBirthYear + 1, pictures: ["cat", "owl", "star"], parentIds: [ids.mom] },
    });
    expect(res.statusCode).toBe(201);
    const leo = res.json();
    expect(leo.kidSignInMethod).toBe("picture");
    expect(leo.signIn).toBe("picture");
    expect(leo.parentIds.sort()).toEqual([ids.dad, ids.mom].sort());
    expect(JSON.stringify(leo)).not.toContain("scrypt");
  });

  it("needs a birth year for a kid", async () => {
    const res = await call({ method: "POST", url: "/api/users", headers: as("dad@example.com"), payload: { displayName: "Leo", role: "kid" } });
    expect(res.statusCode).toBe(400);
  });

  it("only admins add grown-ups", async () => {
    const res = await call({ method: "POST", url: "/api/users", headers: as("dad@example.com"), payload: { displayName: "X", role: "admin" } });
    expect(res.statusCode).toBe(403);
  });

  it("a kid can't change their own birth year, sign-in or parents", async () => {
    const { token } = (
      await call({ method: "POST", url: "/api/auth/kid-sign-in", headers: as("dad@example.com"), payload: { userId: ids.emma, pin: "1234" } })
    ).json();
    const h = bearer(token);
    expect((await call({ method: "PATCH", url: `/api/users/${ids.emma}`, headers: h, payload: { birthYear: 2000 } })).statusCode).toBe(403);
    expect((await call({ method: "PATCH", url: "/api/users/me", headers: h, payload: { birthYear: 2000 } })).statusCode).toBe(400);
    expect((await call({ method: "PUT", url: `/api/users/${ids.emma}/secret`, headers: h, payload: { pin: "0000" } })).statusCode).toBe(403);
    expect((await call({ method: "DELETE", url: `/api/users/${ids.emma}/parents/${ids.dad}`, headers: h })).statusCode).toBe(403);
    // Avatar and theme are fine.
    const ok = await call({ method: "PATCH", url: "/api/users/me", headers: h, payload: { avatar: "dino", theme: "ocean" } });
    expect(ok.statusCode).toBe(200);
    expect(db.select().from(users).all().find((u) => u.id === ids.emma)!.birthYear).toBe(kidBirthYear);
  });

  it("only a linked parent or admin can edit a kid; others can't even see them", async () => {
    expect((await call({ method: "PATCH", url: `/api/users/${ids.emma}`, headers: as("mom@example.com"), payload: { birthYear: 2000 } })).statusCode).toBe(404);
    expect((await call({ method: "GET", url: `/api/users/${ids.emma}`, headers: as("aunt@example.com") })).statusCode).toBe(404);
    const dad = await call({ method: "PATCH", url: `/api/users/${ids.emma}`, headers: as("dad@example.com"), payload: { birthYear: kidBirthYear - 1 } });
    expect(dad.statusCode).toBe(200);
  });

  it("links a co-parent and never removes the last parent", async () => {
    const h = as("dad@example.com");
    expect((await call({ method: "DELETE", url: `/api/users/${ids.emma}/parents/${ids.dad}`, headers: h })).statusCode).toBe(400);
    expect((await call({ method: "POST", url: `/api/users/${ids.emma}/parents`, headers: h, payload: { parentId: ids.aunt } })).statusCode).toBe(400);
    expect((await call({ method: "POST", url: `/api/users/${ids.emma}/parents`, headers: h, payload: { parentId: ids.mom } })).statusCode).toBe(201);
    expect((await call({ method: "DELETE", url: `/api/users/${ids.emma}/parents/${ids.dad}`, headers: h })).statusCode).toBe(200);
    // Dad is no longer linked, so can no longer manage Emma.
    expect((await call({ method: "PATCH", url: `/api/users/${ids.emma}`, headers: h, payload: { displayName: "E" } })).statusCode).toBe(404);
  });

  it("changing a kid's sign-in method clears the old secret", async () => {
    const res = await call({ method: "PATCH", url: `/api/users/${ids.emma}`, headers: as("dad@example.com"), payload: { kidSignInMethod: "picture" } });
    expect(res.json().signIn).toBe("none");
    const set = await call({ method: "PUT", url: `/api/users/${ids.emma}/secret`, headers: as("dad@example.com"), payload: { pictures: ["fox", "bee", "frog", "fish"] } });
    expect(set.json().signIn).toBe("picture");
  });
});

describe("kid PIN and picture sign-in", () => {
  it("is refused with no paired device and nobody signed in", async () => {
    const res = await call({ method: "POST", url: "/api/auth/kid-sign-in", payload: { userId: ids.emma, pin: "1234" } });
    expect(res.statusCode).toBe(401);
    expect((await call({ method: "GET", url: "/api/auth/profiles" })).statusCode).toBe(401);
  });

  it("works on a shared family tablet, and the kid's session is content-locked", async () => {
    const { token: deviceToken } = await pairDevice("dad@example.com", { name: "Living room tablet" });
    // Shared device: no reader, but it can show the picker.
    expect((await call({ method: "GET", url: "/api/books", headers: bearer(deviceToken) })).statusCode).toBe(401);
    const picker = await call({ method: "GET", url: "/api/auth/profiles", headers: bearer(deviceToken) });
    const emma = picker.json().profiles.find((p: { id: string }) => p.id === ids.emma);
    expect(emma.signIn).toBe("pin");

    const wrong = await call({ method: "POST", url: "/api/auth/kid-sign-in", headers: bearer(deviceToken), payload: { userId: ids.emma, pin: "9999" } });
    expect(wrong.statusCode).toBe(401);
    const res = await call({ method: "POST", url: "/api/auth/kid-sign-in", headers: bearer(deviceToken), payload: { userId: ids.emma, pin: "1234" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined(); // apps keep the token themselves
    expect(await titles(bearer(res.json().token))).toEqual(["Picture Book"]);
  });

  it("picture sign-in checks the order", async () => {
    db.update(users).set({ kidSignInMethod: "picture", secretHash: await hashSecret("pictures:cat-owl-star") })
      .where(eq(users.id, ids.emma))
      .run();
    const h = as("dad@example.com");
    const bad = await call({ method: "POST", url: "/api/auth/kid-sign-in", headers: h, payload: { userId: ids.emma, pictures: ["owl", "cat", "star"] } });
    expect(bad.statusCode).toBe(401);
    const pin = await call({ method: "POST", url: "/api/auth/kid-sign-in", headers: h, payload: { userId: ids.emma, pin: "1234" } });
    expect(pin.statusCode).toBe(401);
    const ok = await call({ method: "POST", url: "/api/auth/kid-sign-in", headers: h, payload: { userId: ids.emma, pictures: ["cat", "owl", "star"] } });
    expect(ok.statusCode).toBe(200);
  });

  it("a kid session cookie wins over the parent's proxy header (profile switching)", async () => {
    const res = await call({ method: "POST", url: "/api/auth/kid-sign-in", headers: as("dad@example.com"), payload: { userId: ids.emma, pin: "1234" } });
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    expect(await titles({ ...as("dad@example.com"), cookie })).toEqual(["Picture Book"]);
  });

  it("locks a PIN after 5 wrong tries", async () => {
    const h = as("dad@example.com");
    for (let i = 0; i < 5; i++) {
      await call({ method: "POST", url: "/api/auth/kid-sign-in", headers: h, payload: { userId: ids.emma, pin: `000${i}` } });
    }
    const res = await call({ method: "POST", url: "/api/auth/kid-sign-in", headers: h, payload: { userId: ids.emma, pin: "1234" } });
    expect(res.statusCode).toBe(429);
  });

  it("kids can't use the password endpoint", async () => {
    const res = await call({ method: "POST", url: "/api/auth/login", headers: as("dad@example.com"), payload: { userId: ids.emma, password: "1234" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("QR device pairing", () => {
  it("a kid's own tablet signs straight in as the kid and only shows them", async () => {
    const { token } = await pairDevice("dad@example.com", { name: "Emma's tablet", userId: ids.emma });
    expect(await titles(bearer(token))).toEqual(["Picture Book"]);
    const picker = await call({ method: "GET", url: "/api/auth/profiles", headers: bearer(token) });
    expect(picker.json().profiles.map((p: { id: string }) => p.id)).toEqual([ids.emma]);
    // Nobody else can sign in on it.
    const other = await call({ method: "POST", url: "/api/auth/login", headers: bearer(token), payload: { userId: ids.admin, password: "admin-password" } });
    expect(other.statusCode).toBe(403);
  });

  it("codes are one-time", async () => {
    const { code } = await pairDevice("dad@example.com", { name: "Tablet" });
    const again = await call({ method: "POST", url: "/api/devices/claim", payload: { code } });
    expect(again.statusCode).toBe(400);
  });

  it("a parent can't lock a device to a kid they aren't linked to; kids can't pair", async () => {
    expect(
      (await call({ method: "POST", url: "/api/devices/pairings", headers: as("mom@example.com"), payload: { name: "T", userId: ids.emma } })).statusCode,
    ).toBe(404);
    const { token } = await pairDevice("dad@example.com", { name: "Emma's tablet", userId: ids.emma });
    expect((await call({ method: "POST", url: "/api/devices/pairings", headers: bearer(token), payload: { name: "T" } })).statusCode).toBe(403);
  });

  it("revoking a device kills its token and every session signed in on it", async () => {
    const { token, device } = await pairDevice("dad@example.com", { name: "Living room tablet" });
    const session = (
      await call({ method: "POST", url: "/api/auth/kid-sign-in", headers: bearer(token), payload: { userId: ids.emma, pin: "1234" } })
    ).json().token;
    const list = await call({ method: "GET", url: "/api/devices", headers: as("dad@example.com") });
    expect(list.json().devices.map((d: { id: string }) => d.id)).toEqual([device.id]);

    const del = await call({ method: "DELETE", url: `/api/devices/${device.id}`, headers: as("dad@example.com") });
    expect(del.json().revokedAt).toBeTypeOf("number");
    expect((await call({ method: "GET", url: "/api/auth/profiles", headers: bearer(token) })).statusCode).toBe(401);
    expect((await call({ method: "GET", url: "/api/books", headers: bearer(session) })).statusCode).toBe(401);
  });

  it("a bad device token doesn't fall back to the proxy header", async () => {
    const res = await call({ method: "GET", url: "/api/books", headers: { ...as("dad@example.com"), ...bearer("bbd_nope") } });
    expect(res.statusCode).toBe(401);
  });
});
