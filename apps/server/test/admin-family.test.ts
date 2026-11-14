import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { aiMessages, bookFiles, bookRequests, books, bookmarks, readingProgress, settings } from "../src/db/schema.js";
import { resolveLookup } from "../src/routes/admin-settings.js";
import { lazyBox } from "../src/integrations/index.js";
import { family, KEY, type Family } from "./helpers.js";

let f: Family;
beforeEach(async () => {
  f = await family({}, { METADATA_ONLINE: "false" });
});
afterEach(async () => {
  await f.close();
});

type Who = "admin" | "parent" | "adult" | "kid";
const call = (who: Who, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) =>
  f.app.inject({ method, url, headers: f.as(who), payload: payload as object });

const progress = (userId: string, bookId: string, percent: number, at: number, finished = false) =>
  f.db
    .insert(readingProgress)
    .values({ userId, bookId, locator: { kind: "epub", cfi: "", percent }, percent, finished, clientUpdatedAt: at, serverUpdatedAt: at })
    .run();

describe("admin library routes", () => {
  it("are admin-only", async () => {
    const id = f.book("Some Book", null);
    for (const who of ["parent", "adult", "kid"] as const) {
      expect((await call(who, "GET", "/api/admin/overview")).statusCode).toBe(403);
      expect((await call(who, "GET", "/api/admin/review/unrated")).statusCode).toBe(403);
      expect((await call(who, "GET", `/api/admin/books/${id}`)).statusCode).toBe(403);
      expect((await call(who, "PATCH", `/api/admin/books/${id}`, { title: "x" })).statusCode).toBe(403);
      expect((await call(who, "POST", `/api/admin/books/${id}/merge`, { intoId: id })).statusCode).toBe(403);
      expect((await call(who, "GET", "/api/admin/settings/metadata")).statusCode).toBe(403);
      expect((await call(who, "PUT", "/api/admin/settings/metadata", { online: true })).statusCode).toBe(403);
    }
  });

  it("lists approved unrated books for review and counts them in the overview", async () => {
    const unrated = f.book("Mystery Rating", null);
    f.book("Rated", "kids");
    f.book("In The Inbox", null, { approved: false });
    f.book("Kindle Only", null, { kindleOnly: true });
    const res = await call("admin", "GET", "/api/admin/review/unrated");
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((b: { id: string }) => b.id)).toEqual([unrated]);
    expect(res.json().total).toBe(1);
    const all = (await call("admin", "GET", "/api/admin/review/unrated?scope=all")).json();
    expect(all.total).toBe(2);

    const o = (await call("admin", "GET", "/api/admin/overview")).json();
    expect(o).toMatchObject({ inbox: 1, unrated: 1, people: { grownUps: 3, kids: 2 }, devices: 0, pendingRequests: 0 });
  });

  it("edits metadata, authors and rating", async () => {
    const id = f.book("teh hobbit", null, { approved: false });
    const res = await call("admin", "PATCH", `/api/admin/books/${id}`, {
      title: "The Hobbit",
      authors: ["J. R. R. Tolkien"],
      publishedYear: 1937,
      isbn13: "978-0-261-10221-7",
      description: "",
      rating: "middle_grade",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      title: "The Hobbit",
      authors: ["J. R. R. Tolkien"],
      publishedYear: 1937,
      isbn13: "9780261102217",
      description: null,
      rating: "middle_grade",
      ratingSource: "admin",
      approved: false,
    });
    const row = f.db.select().from(books).where(eq(books.id, id)).get()!;
    expect(row.sortTitle).not.toBe("teh hobbit");

    expect((await call("admin", "PATCH", `/api/admin/books/${id}`, { isbn13: "123" })).statusCode).toBe(400);
    expect((await call("admin", "PATCH", `/api/admin/books/${id}`, { nope: 1 })).statusCode).toBe(400);
    expect((await call("admin", "PATCH", "/api/admin/books/missing", { title: "x" })).statusCode).toBe(404);
  });

  it("merges a duplicate: files, progress (newest wins) and bookmarks move; gaps fill", async () => {
    const keep = f.book("Dune", "teen");
    const dupe = f.book("Dune", null, { approved: false, isbn13: "9780441013593", description: "Spice." });
    f.db.insert(bookFiles).values({ bookId: dupe, relPath: "dune.epub", format: "epub", sizeBytes: 10 }).run();
    progress(f.ids.parent, keep, 0.1, 1000);
    progress(f.ids.parent, dupe, 0.5, 2000);
    progress(f.ids.adult, dupe, 0.3, 1500);
    f.db.insert(bookmarks).values({ userId: f.ids.adult, bookId: dupe, kind: "bookmark", locator: { kind: "epub", cfi: "", percent: 0.3 } }).run();

    const res = await call("admin", "POST", `/api/admin/books/${dupe}/merge`, { intoId: keep });
    expect(res.statusCode).toBe(200);
    expect(res.json().into).toMatchObject({ id: keep, rating: "teen", isbn13: "9780441013593", description: "Spice.", approved: true });
    expect(res.json().into.files.map((x: { relPath: string }) => x.relPath)).toEqual(["dune.epub"]);
    expect(f.db.select().from(books).where(eq(books.id, dupe)).get()).toBeUndefined();
    const prog = f.db.select().from(readingProgress).where(eq(readingProgress.bookId, keep)).all();
    expect(prog.find((p) => p.userId === f.ids.parent)!.percent).toBe(0.5);
    expect(prog.find((p) => p.userId === f.ids.adult)!.percent).toBe(0.3);
    expect(f.db.select().from(bookmarks).where(eq(bookmarks.bookId, keep)).all()).toHaveLength(1);

    expect((await call("admin", "POST", `/api/admin/books/${keep}/merge`, { intoId: keep })).statusCode).toBe(400);
  });
});

describe("metadata settings", () => {
  it("stores keys sealed, never returns them, and drives lookups", async () => {
    const box = lazyBox(() => KEY);
    const env = { METADATA_ONLINE: false, HARDCOVER_API_TOKEN: undefined, GOOGLE_BOOKS_API_KEY: "env-google" };
    expect((await call("admin", "GET", "/api/admin/settings/metadata")).json()).toMatchObject({
      online: false,
      hasHardcoverToken: false,
      saved: false,
    });

    const put = await call("admin", "PUT", "/api/admin/settings/metadata", { online: true, hardcoverToken: "hc-secret" });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain("hc-secret");
    expect(put.json()).toMatchObject({ online: true, hasHardcoverToken: true, saved: true });
    const raw = JSON.stringify(f.db.select().from(settings).where(eq(settings.key, "metadata.lookup")).get());
    expect(raw).not.toContain("hc-secret");
    expect(resolveLookup(f.db, box, env)).toEqual({ hardcoverToken: "hc-secret", googleApiKey: "env-google" });

    // Omitting a key keeps it; null clears it.
    await call("admin", "PUT", "/api/admin/settings/metadata", { online: true });
    expect(resolveLookup(f.db, box, env)).toMatchObject({ hardcoverToken: "hc-secret" });
    await call("admin", "PUT", "/api/admin/settings/metadata", { online: false, hardcoverToken: null });
    expect(resolveLookup(f.db, box, env)).toBe(false);

    // Metadata refresh reads the setting at request time.
    const id = f.book("Anything", null);
    expect((await call("admin", "POST", `/api/admin/books/${id}/metadata/refresh`)).statusCode).toBe(409);
  });
});

describe("family dashboard", () => {
  it("is for parents of the kid and admins only", async () => {
    expect((await call("kid", "GET", "/api/family/kids")).statusCode).toBe(403);
    expect((await call("adult", "GET", "/api/family/kids")).statusCode).toBe(403);
    expect((await call("kid", "GET", `/api/family/kids/${f.ids.kid}`)).statusCode).toBe(403);

    const parent = (await call("parent", "GET", "/api/family/kids")).json();
    expect(parent.kids.map((k: { id: string }) => k.id)).toEqual([f.ids.kid]);
    // Not their kid: 404 so ids reveal nothing.
    expect((await call("parent", "GET", `/api/family/kids/${f.ids.otherKid}`)).statusCode).toBe(404);
    // A grown-up's id isn't a kid.
    expect((await call("admin", "GET", `/api/family/kids/${f.ids.adult}`)).statusCode).toBe(404);

    const admin = (await call("admin", "GET", "/api/family/kids")).json();
    expect(admin.kids).toHaveLength(2);
  });

  it("shows reading, requests and AI chats, with books filtered by the content lock", async () => {
    const now = Date.now();
    const picture = f.book("Gruffalo", "kids");
    const done = f.book("Matilda", "middle_grade");
    const hidden = f.book("Not For Dad", "explicit");
    progress(f.ids.kid, picture, 0.4, now - 1000);
    progress(f.ids.kid, done, 1, now - 2000, true);
    // Shouldn't happen for a kid, but if it did the parent (no explicit opt-in) still mustn't see it.
    progress(f.ids.kid, hidden, 0.2, now);
    f.db.insert(bookRequests).values({ requestedBy: f.ids.kid, title: "Dog Man", status: "pending" }).run();
    f.db
      .insert(aiMessages)
      .values([
        { userId: f.ids.kid, conversationId: "c1", role: "system", content: "You are Barnaby", createdAt: now - 500 },
        { userId: f.ids.kid, conversationId: "c1", role: "user", content: "Why is the Gruffalo scary?", bookId: picture, createdAt: now - 400 },
        { userId: f.ids.kid, conversationId: "c1", role: "assistant", content: "He looks big but...", createdAt: now - 300 },
        { userId: f.ids.kid, conversationId: "c2", role: "user", content: "rude words", moderation: "blocked", createdAt: now - 200 },
      ])
      .run();

    const list = (await call("parent", "GET", "/api/family/kids")).json();
    expect(list.kids[0].stats).toMatchObject({
      readingNow: 1,
      finished: 1,
      finishedLast30Days: 1,
      pendingRequests: 1,
      aiQuestionsLast7Days: 2,
      aiFlaggedLast7Days: 1,
      lastBook: { id: picture, title: "Gruffalo" },
    });

    const res = await call("parent", "GET", `/api/family/kids/${f.ids.kid}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reading.map((r: { bookId: string }) => r.bookId)).toEqual([picture, done]);
    expect(JSON.stringify(body)).not.toContain("Not For Dad");
    expect(body.requests).toMatchObject([{ title: "Dog Man", status: "pending" }]);
    expect(body.chats).toHaveLength(2);
    expect(body.chats.find((c: { conversationId: string }) => c.conversationId === "c1")).toMatchObject({
      preview: "Why is the Gruffalo scary?",
      bookTitle: "Gruffalo",
      flagged: 0,
    });

    const chat = await call("parent", "GET", `/api/family/kids/${f.ids.kid}/chats/c1`);
    expect(chat.json().messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect((await call("parent", "GET", `/api/family/kids/${f.ids.kid}/chats/nope`)).statusCode).toBe(404);
    expect((await call("kid", "GET", `/api/family/kids/${f.ids.kid}/chats/c1`)).statusCode).toBe(403);
  });
});
