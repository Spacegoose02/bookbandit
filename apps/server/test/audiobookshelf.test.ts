import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authors, bookAuthors, books, settings } from "../src/db/schema.js";
import { family, type Family } from "./helpers.js";
import { matchBooks, normalizeIsbn, normalizeTitle } from "../src/integrations/audiobookshelf/match.js";
import type { AbsItemSummary } from "../src/integrations/audiobookshelf/client.js";

const ABS = "http://abs.local:13378";
const TOKEN = "abs-secret-token";

const rawItem = (id: string, title: string, author: string, extra: Record<string, unknown> = {}) => ({
  id,
  libraryId: "lib1",
  mediaType: "book",
  media: {
    metadata: { title, authorName: author, narratorName: "Reader Person", ...extra },
    duration: 600,
    chapters: [{ start: 0, end: 300, title: "One" }, { start: 300, end: 600, title: "Two" }],
    audioFiles: [
      { index: 2, ino: "ino-b", duration: 300, mimeType: "audio/mpeg", metadata: { filename: "02.mp3" } },
      { index: 1, ino: "ino-a", duration: 300, mimeType: "audio/mpeg", metadata: { filename: "01.mp3" } },
      { index: 3, ino: "ino-x", duration: 5, exclude: true },
    ],
  },
});

const ITEMS = [
  rawItem("abs-gruffalo", "The Gruffalo", "Julia Donaldson", { isbn: "0-333-71093-2" }),
  rawItem("abs-thriller", "Gone Girl", "Gillian Flynn"),
  rawItem("abs-hobbit", "The Hobbit (Unabridged)", "J.R.R. Tolkien"),
];

const calls: { url: string; headers: Record<string, string> }[] = [];

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
  calls.push({ url, headers });
  if (headers.Authorization !== `Bearer ${TOKEN}`) return new Response("no", { status: 401 });
  const path = url.slice(ABS.length);
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  if (path === "/api/me") return json({ username: "root" });
  if (path === "/api/libraries") return json({ libraries: [{ id: "lib1", name: "Audiobooks", mediaType: "book" }, { id: "pod", name: "Pods", mediaType: "podcast" }] });
  if (path.startsWith("/api/libraries/lib1/items")) return json({ results: ITEMS, total: ITEMS.length });
  const item = path.match(/^\/api\/items\/([^/?]+)\?expanded=1$/);
  if (item) {
    const found = ITEMS.find((i) => i.id === item[1]);
    return found ? json(found) : new Response("nf", { status: 404 });
  }
  const file = path.match(/^\/api\/items\/([^/]+)\/file\/([^/]+)$/);
  if (file) {
    const body = new TextEncoder().encode(`AUDIO:${file[1]}:${file[2]}`);
    if (headers.Range) {
      return new Response(body.slice(0, 4), {
        status: 206,
        headers: { "content-type": "audio/mpeg", "content-range": `bytes 0-3/${body.length}`, "accept-ranges": "bytes" },
      });
    }
    return new Response(body, { headers: { "content-type": "audio/mpeg", "content-length": String(body.length) } });
  }
  return new Response("nf", { status: 404 });
}) as typeof fetch;

let f: Family;

beforeEach(async () => {
  calls.length = 0;
  f = await family({ integrations: { fetchImpl: fakeFetch } });
});
afterEach(() => f.close());

async function connect() {
  const res = await f.app.inject({
    method: "PUT",
    url: "/api/admin/integrations/audiobookshelf",
    headers: f.as("admin"),
    payload: { url: ABS + "/", token: TOKEN },
  });
  expect(res.statusCode).toBe(200);
  return res;
}

describe("audiobookshelf settings", () => {
  it("are admin-only and never return or store the token in plain text", async () => {
    const denied = await f.app.inject({
      method: "PUT",
      url: "/api/admin/integrations/audiobookshelf",
      headers: f.as("parent"),
      payload: { url: ABS, token: TOKEN },
    });
    expect(denied.statusCode).toBe(403);

    const res = await connect();
    expect(res.json()).toEqual({ configured: true, enabled: true, url: ABS, libraryIds: [], hasToken: true });
    expect(res.body).not.toContain(TOKEN);
    const row = f.db.select().from(settings).all();
    expect(JSON.stringify(row)).not.toContain(TOKEN);

    // Saving again without a token keeps the stored one.
    await f.app.inject({
      method: "PUT",
      url: "/api/admin/integrations/audiobookshelf",
      headers: f.as("admin"),
      payload: { url: ABS, libraryIds: ["lib1"] },
    });
    const test = await f.app.inject({ method: "POST", url: "/api/admin/integrations/audiobookshelf/test", headers: f.as("admin") });
    expect(test.json()).toMatchObject({ ok: true, username: "root" });
  });
});

describe("audiobook playback", () => {
  let kidsBook: string;
  let adultBook: string;

  beforeEach(async () => {
    await connect();
    kidsBook = f.book("The Gruffalo", "kids", { absItemId: "abs-gruffalo" });
    adultBook = f.book("Gone Girl", "adult", { absItemId: "abs-thriller" });
  });

  it("gives a kid the tracks of a kids audiobook in order, through Bookbandit", async () => {
    const res = await f.app.inject({ url: `/api/books/${kidsBook}/audio`, headers: f.as("kid") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tracks.map((t: { title: string; startOffset: number }) => [t.title, t.startOffset])).toEqual([
      ["01.mp3", 0],
      ["02.mp3", 300],
    ]);
    expect(body.tracks[0].url).toBe(`/api/books/${kidsBook}/audio/tracks/0`);
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain(ABS);

    const stream = await f.app.inject({
      url: `/api/books/${kidsBook}/audio/tracks/1`,
      headers: { ...f.as("kid"), range: "bytes=0-3" },
    });
    expect(stream.statusCode).toBe(206);
    expect(stream.headers["content-range"]).toBe("bytes 0-3/24");
    expect(stream.body).toBe("AUDI");
    expect(calls.at(-1)!.url).toBe(`${ABS}/api/items/abs-gruffalo/file/ino-b`);
    expect(calls.at(-1)!.headers.Range).toBe("bytes=0-3");
  });

  it("returns 404 to a kid for a locked audiobook, its tracks, cover and progress", async () => {
    for (const url of [
      `/api/books/${adultBook}/audio`,
      `/api/books/${adultBook}/audio/tracks/0`,
      `/api/books/${adultBook}/audio/cover`,
      `/api/books/${adultBook}/audio/progress`,
    ]) {
      const res = await f.app.inject({ url, headers: f.as("kid") });
      expect(res.statusCode, url).toBe(404);
    }
    const put = await f.app.inject({
      method: "PUT",
      url: `/api/books/${adultBook}/audio/progress`,
      headers: f.as("kid"),
      payload: { currentTime: 1, duration: 600, clientUpdatedAt: Date.now() },
    });
    expect(put.statusCode).toBe(404);
    expect(calls.some((c) => c.url.includes("abs-thriller"))).toBe(false);
  });

  it("requires sign-in", async () => {
    const res = await f.app.inject({ url: `/api/books/${kidsBook}/audio` });
    expect(res.statusCode).toBe(401);
  });

  it("syncs listening position across devices, newest write wins", async () => {
    const put = (currentTime: number, clientUpdatedAt: number, deviceName: string) =>
      f.app.inject({
        method: "PUT",
        url: `/api/books/${kidsBook}/audio/progress`,
        headers: f.as("kid"),
        payload: { currentTime, duration: 600, clientUpdatedAt, deviceName },
      });
    expect((await put(120, 1000, "tablet")).json().applied).toBe(true);
    expect((await put(30, 900, "old phone")).json().applied).toBe(false);
    const res = await f.app.inject({ url: `/api/books/${kidsBook}/audio`, headers: f.as("kid") });
    expect(res.json().progress).toMatchObject({ currentTime: 120, deviceName: "tablet", finished: false, percent: 0.2 });

    // Someone else's progress is separate.
    const dad = await f.app.inject({ url: `/api/books/${kidsBook}/audio/progress`, headers: f.as("parent") });
    expect(dad.json().progress).toBeNull();

    const cont = await f.app.inject({ url: "/api/audio/continue", headers: f.as("kid") });
    expect(cont.json().items.map((i: { id: string }) => i.id)).toEqual([kidsBook]);

    // If the book is re-rated above the kid's limit it drops off their shelf.
    f.db.update(books).set({ rating: "teen" }).where(eq(books.id, kidsBook)).run();
    const after = await f.app.inject({ url: "/api/audio/continue", headers: f.as("kid") });
    expect(after.json().items).toEqual([]);
  });

  it("marks a book finished near the end", async () => {
    const res = await f.app.inject({
      method: "PUT",
      url: `/api/books/${kidsBook}/audio/progress`,
      headers: f.as("kid"),
      payload: { currentTime: 590, duration: 600, clientUpdatedAt: Date.now() },
    });
    expect(res.json().progress.finished).toBe(true);
  });
});

describe("linking books to audiobooks", () => {
  beforeEach(connect);

  it("lets admins link by hand, and refuses double links", async () => {
    const a = f.book("Gone Girl", "adult");
    const b = f.book("Gone Girl (copy)", "adult", { absItemId: "abs-thriller" });
    const parent = await f.app.inject({
      method: "PUT",
      url: `/api/admin/books/${a}/audiobookshelf`,
      headers: f.as("parent"),
      payload: { absItemId: "abs-hobbit" },
    });
    expect(parent.statusCode).toBe(403);

    const dup = await f.app.inject({
      method: "PUT",
      url: `/api/admin/books/${a}/audiobookshelf`,
      headers: f.as("admin"),
      payload: { absItemId: "abs-thriller" },
    });
    expect(dup.statusCode).toBe(409);

    const missing = await f.app.inject({
      method: "PUT",
      url: `/api/admin/books/${a}/audiobookshelf`,
      headers: f.as("admin"),
      payload: { absItemId: "nope" },
    });
    expect(missing.statusCode).toBe(404);

    const ok = await f.app.inject({
      method: "PUT",
      url: `/api/admin/books/${a}/audiobookshelf`,
      headers: f.as("admin"),
      payload: { absItemId: "abs-hobbit" },
    });
    expect(ok.statusCode).toBe(200);
    expect(f.db.select().from(books).where(eq(books.id, a)).get()!.absItemId).toBe("abs-hobbit");

    const del = await f.app.inject({ method: "DELETE", url: `/api/admin/books/${b}/audiobookshelf`, headers: f.as("admin") });
    expect(del.statusCode).toBe(204);
  });

  it("auto-links by ISBN and by title + author", async () => {
    const gruffalo = f.book("Gruffalo", "kids", { isbn13: "9780333710937" });
    const hobbit = f.book("The Hobbit", "middle_grade");
    const [tolkien] = f.db.insert(authors).values({ name: "J. R. R. Tolkien", sortName: "Tolkien, J. R. R." }).returning().all();
    f.db.insert(bookAuthors).values({ bookId: hobbit, authorId: tolkien!.id }).run();
    f.book("Gone Girl", "adult"); // no author → not linked by title alone

    const dry = await f.app.inject({
      method: "POST",
      url: "/api/admin/audiobookshelf/auto-link",
      headers: f.as("admin"),
      payload: { dryRun: true },
    });
    expect(dry.json().linked).toHaveLength(2);
    expect(f.db.select().from(books).where(eq(books.id, gruffalo)).get()!.absItemId).toBeNull();

    const res = await f.app.inject({ method: "POST", url: "/api/admin/audiobookshelf/auto-link", headers: f.as("admin"), payload: {} });
    expect(res.json().linked.map((l: { reason: string }) => l.reason).sort()).toEqual(["isbn", "title_author"]);
    expect(f.db.select().from(books).where(eq(books.id, gruffalo)).get()!.absItemId).toBe("abs-gruffalo");
    expect(f.db.select().from(books).where(eq(books.id, hobbit)).get()!.absItemId).toBe("abs-hobbit");

    const items = await f.app.inject({ url: "/api/admin/audiobookshelf/items?unlinked=true", headers: f.as("admin") });
    expect(items.json().items.map((i: { id: string }) => i.id)).toEqual(["abs-thriller"]);
  });
});

describe("matching", () => {
  const item = (id: string, title: string, authorName: string | null, isbn: string | null = null): AbsItemSummary => ({
    id,
    libraryId: "l",
    title,
    subtitle: null,
    authorName,
    narratorName: null,
    seriesName: null,
    isbn,
    asin: null,
    duration: 1,
  });

  it("normalizes ISBNs and titles", () => {
    expect(normalizeIsbn("0-333-71093-2")).toBe("9780333710937");
    expect(normalizeIsbn("978-0-333-71093-7")).toBe("9780333710937");
    expect(normalizeTitle("The Hobbit: There and Back Again (Unabridged)")).toBe("hobbit");
  });

  it("skips ambiguous title matches", () => {
    const m = matchBooks(
      [{ id: "b", title: "Dune", isbn13: null, kindleAsin: null, authors: ["Frank Herbert"] }],
      [item("1", "Dune", "Frank Herbert"), item("2", "Dune", "Frank Herbert")],
    );
    expect(m).toEqual([]);
  });

  it("needs a matching author surname for title matches", () => {
    const m = matchBooks(
      [{ id: "b", title: "It", isbn13: null, kindleAsin: null, authors: ["Stephen King"] }],
      [item("1", "It", "Someone Else")],
    );
    expect(m).toEqual([]);
  });
});
