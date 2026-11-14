import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { openDb, type Db } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { books, households, userIdentities, users } from "../../src/db/schema.js";
import { makeEpub, tempDir } from "./fixtures.js";

let app: FastifyInstance;
let db: Db;
let close: () => void;
let booksDir: string;

const kidBirthYear = new Date().getUTCFullYear() - 8; // a 7-year-old

beforeEach(async () => {
  ({ db, close } = openDb(":memory:"));
  booksDir = await tempDir("bb-books-");
  const configDir = await tempDir("bb-config-");
  const [home] = db.insert(households).values({ name: "Home" }).returning().all();
  const people = db
    .insert(users)
    .values([
      { householdId: home!.id, displayName: "Admin", role: "admin" },
      { householdId: home!.id, displayName: "Dad", role: "parent" },
      { householdId: home!.id, displayName: "Emma", role: "kid", birthYear: kidBirthYear, kidSignInMethod: "google" },
    ])
    .returning()
    .all();
  db.insert(userIdentities)
    .values(people.map((p) => ({ userId: p.id, provider: "tinyauth" as const, subject: `${p.displayName.toLowerCase()}@example.com` })))
    .run();
  const config = loadConfig({
    TRUSTED_PROXIES: "127.0.0.1",
    LOG_LEVEL: "error",
    BOOKS_DIR: booksDir,
    CONFIG_DIR: configDir,
    METADATA_ONLINE: "false",
  } as NodeJS.ProcessEnv);
  app = await buildApp(config, db);
});

afterEach(async () => {
  await app.close();
  close();
});

const as = (who: string) => ({ "remote-email": `${who}@example.com` });
const req = (who: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: as(who), payload: payload as object });

async function scanNow() {
  const res = await req("admin", "POST", "/api/admin/library/scan");
  expect(res.statusCode).toBe(202);
  for (let i = 0; i < 100; i++) {
    const s = (await req("admin", "GET", "/api/admin/library/scan")).json();
    if (!s.running) return s.lastReport;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("scan did not finish");
}

const titles = async (who: string) =>
  ((await req(who, "GET", "/api/books")).json().items as { title: string }[]).map((b) => b.title).sort();

describe("library admin API", () => {
  it("is admin-only", async () => {
    for (const who of ["dad", "emma"]) {
      expect((await req(who, "GET", "/api/admin/inbox")).statusCode).toBe(403);
      expect((await req(who, "POST", "/api/admin/library/scan")).statusCode).toBe(403);
      expect((await req(who, "POST", "/api/admin/inbox/approve", { ids: ["x"] })).statusCode).toBe(403);
      expect((await req(who, "PUT", "/api/admin/books/x/rating", { rating: "kids" })).statusCode).toBe(403);
      expect((await req(who, "GET", "/api/admin/library/duplicates")).statusCode).toBe(403);
    }
  });

  it("keeps new books in the inbox until approved, then applies the content lock", async () => {
    await makeEpub(join(booksDir, "kids/Picture.epub"), { title: "Picture", authors: ["P"] });
    await makeEpub(join(booksDir, "Romance/Hot.epub"), { title: "Hot", authors: ["H"], subjects: ["Erotica"], salt: "h" });
    await makeEpub(join(booksDir, "Thriller.epub"), { title: "Thriller", authors: ["T"], salt: "t" });
    const report = await scanNow();
    expect(report.added).toBe(3);

    // Nobody but the admin sees inbox books.
    expect(await titles("emma")).toEqual([]);
    expect(await titles("dad")).toEqual([]);

    const inbox = (await req("admin", "GET", "/api/admin/inbox")).json();
    expect(inbox.total).toBe(3);
    const byTitle = Object.fromEntries(inbox.items.map((b: { title: string }) => [b.title, b]));
    expect(byTitle.Picture).toMatchObject({ rating: "kids", ratingSource: "folder", authors: ["P"] });
    expect(byTitle.Hot).toMatchObject({ rating: "explicit", ratingSource: "keywords" });
    expect(byTitle.Thriller.rating).toBeNull();

    const ids = inbox.items.map((b: { id: string }) => b.id);
    expect((await req("admin", "POST", "/api/admin/inbox/approve", { ids })).json()).toEqual({ approved: 3 });

    expect(await titles("emma")).toEqual(["Picture"]);
    expect(await titles("dad")).toEqual(["Picture", "Thriller"]); // unrated = adult; explicit hidden
    const hot = byTitle.Hot.id;
    expect((await req("emma", "GET", `/api/books/${hot}`)).statusCode).toBe(404);
  });

  it("lets an admin rate a book, and a rescan never overrides it", async () => {
    await makeEpub(join(booksDir, "adult/Fairy Tales.epub"), { title: "Fairy Tales", authors: ["Grimm"] });
    await scanNow();
    const book = db.select().from(books).get()!;
    expect(book.rating).toBe("adult");

    const res = await req("admin", "PUT", `/api/admin/books/${book.id}/rating`, { rating: "kids" });
    expect(res.json()).toMatchObject({ rating: "kids", ratingSource: "admin" });
    await req("admin", "POST", `/api/admin/inbox/${book.id}/approve`, {});
    expect(await titles("emma")).toEqual(["Fairy Tales"]);

    await scanNow();
    expect(db.select().from(books).get()).toMatchObject({ rating: "kids", ratingSource: "admin" });
    expect((await req("admin", "PUT", `/api/admin/books/${book.id}/rating`, { rating: "spicy" })).statusCode).toBe(400);
  });

  it("approves with a rating in one step", async () => {
    await makeEpub(join(booksDir, "Unknown.epub"), { title: "Unknown", authors: ["U"] });
    await scanNow();
    const id = db.select().from(books).get()!.id;
    const res = await req("admin", "POST", `/api/admin/inbox/${id}/approve`, { rating: "middle_grade" });
    expect(res.json()).toMatchObject({ approved: true, rating: "middle_grade", ratingSource: "admin" });
    expect((await req("admin", "POST", `/api/admin/inbox/nope/approve`, {})).statusCode).toBe(404);
  });

  it("rejects a book by moving its files to .rejected, so a rescan skips it", async () => {
    await makeEpub(join(booksDir, "downloads/Junk.epub"), { title: "Junk", authors: ["J"] });
    await scanNow();
    const id = db.select().from(books).get()!.id;
    const res = await req("admin", "POST", `/api/admin/inbox/${id}/reject`, {});
    expect(res.json()).toMatchObject({ rejected: id, movedTo: [".rejected/downloads/Junk.epub"] });
    await expect(stat(join(booksDir, ".rejected/downloads/Junk.epub"))).resolves.toBeDefined();
    expect(db.select().from(books).all()).toHaveLength(0);

    const again = await scanNow();
    expect(again.added).toBe(0);
    expect(db.select().from(books).all()).toHaveLength(0);
  });

  it("can't reject an approved book through the inbox", async () => {
    await makeEpub(join(booksDir, "Keep.epub"), { title: "Keep", authors: ["K"] });
    await scanNow();
    const id = db.select().from(books).get()!.id;
    db.update(books).set({ approved: true }).where(eq(books.id, id)).run();
    expect((await req("admin", "POST", `/api/admin/inbox/${id}/reject`, {})).statusCode).toBe(404);
  });

  it("lists duplicates: same file twice and same work twice", async () => {
    await makeEpub(join(booksDir, "a/Twin.epub"), { title: "Twin", authors: ["T"] });
    await scanNow();
    // Copy, don't regenerate: zip entries carry a timestamp, so a rebuilt file can differ.
    await mkdir(join(booksDir, "b"));
    await copyFile(join(booksDir, "a/Twin.epub"), join(booksDir, "b/Twin.epub"));
    await makeEpub(join(booksDir, "Dune.epub"), { title: "Dune", authors: ["Frank Herbert"], salt: "d1" });
    await makeEpub(join(booksDir, "Dune (other).epub"), { title: "Dune", authors: ["Somebody Else"], salt: "d2" });
    await scanNow();
    const dup = (await req("admin", "GET", "/api/admin/library/duplicates")).json();
    expect(dup.sameFile).toHaveLength(1);
    expect(dup.sameFile[0].paths.sort()).toEqual(["a/Twin.epub", "b/Twin.epub"]);
    expect(dup.sameWork).toHaveLength(1);
    expect(dup.sameWork[0]).toMatchObject({ reason: "title", key: "dune" });
    expect(dup.sameWork[0].books).toHaveLength(2);
  });

  it("refresh answers 409 when online lookup is off", async () => {
    await makeEpub(join(booksDir, "X.epub"), { title: "X", authors: ["Y"] });
    await scanNow();
    const id = db.select().from(books).get()!.id;
    expect((await req("admin", "POST", `/api/admin/books/${id}/metadata/refresh`)).statusCode).toBe(409);
  });
});

describe("startup scan", () => {
  it("scans when the server starts listening, and skips an empty folder", async () => {
    const make = async (dir: string) => {
      const { db: d, close: c } = openDb(":memory:");
      const cfg = loadConfig({ LOG_LEVEL: "error", BOOKS_DIR: dir, CONFIG_DIR: await tempDir("bb-config-"), METADATA_ONLINE: "false" } as NodeJS.ProcessEnv);
      const a = await buildApp(cfg, d);
      await a.listen({ port: 0, host: "127.0.0.1" });
      return { a, d, c };
    };
    const full = await tempDir("bb-books-");
    await makeEpub(join(full, "Boot.epub"), { title: "Boot", authors: ["B"] });
    const one = await make(full);
    for (let i = 0; i < 100 && !one.d.select().from(books).get(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(one.d.select().from(books).all().map((b) => b.title)).toEqual(["Boot"]);
    await one.a.close();
    one.c();

    const two = await make(join(await tempDir("bb-none-"), "missing"));
    await new Promise((r) => setTimeout(r, 50));
    expect(two.d.select().from(books).all()).toEqual([]);
    await two.a.close();
    two.c();
  });
});
