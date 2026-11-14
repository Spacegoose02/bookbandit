import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { loadConfig } from "../src/config.js";
import { books, households, parentLinks, userIdentities, users } from "../src/db/schema.js";

let app: FastifyInstance;
let db: Db;
let close: () => void;
const ids: Record<string, string> = {};

const kidBirthYear = new Date().getUTCFullYear() - 8; // 7 by our conservative age rule

beforeEach(async () => {
  ({ db, close } = openDb(":memory:"));
  const [home] = db.insert(households).values({ name: "Home" }).returning().all();
  const person = (displayName: string, role: "admin" | "parent" | "adult" | "kid", email: string) => {
    const [u] = db
      .insert(users)
      .values({
        householdId: home!.id,
        displayName,
        role,
        ...(role === "kid" ? { birthYear: kidBirthYear, kidSignInMethod: "google" as const } : {}),
      })
      .returning()
      .all();
    db.insert(userIdentities).values({ userId: u!.id, provider: "tinyauth", subject: email }).run();
    ids[displayName] = u!.id;
  };
  person("Admin", "admin", "admin@example.com");
  person("Dad", "parent", "dad@example.com");
  person("Aunt", "adult", "aunt@example.com");
  person("Emma", "kid", "emma@example.com");
  person("Leo", "kid", "leo@example.com");
  db.insert(parentLinks).values({ parentId: ids.Dad!, kidId: ids.Emma! }).run();

  const book = (title: string, rating: (typeof books.$inferInsert)["rating"], approved = true) => {
    const [b] = db.insert(books).values({ title, sortTitle: title.toLowerCase(), rating, approved }).returning().all();
    ids[title] = b!.id;
  };
  book("Picture Book", "kids");
  book("Bedtime Story", "kids");
  book("Thriller", "adult");
  book("Inbox Book", "kids", false);

  const config = loadConfig({ TRUSTED_PROXIES: "127.0.0.1", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  app = await buildApp(config, db);
});

afterEach(async () => {
  await app.close();
  close();
});

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const call = (who: string, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { "remote-email": `${who.toLowerCase()}@example.com` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const epub = (percent: number) => ({ kind: "epub" as const, cfi: `epubcfi(/6/${Math.round(percent * 100)})`, percent });
const save = (who: string, title: string, percent: number, at: string | number, deviceName = "Tablet") =>
  call(who, "PUT", `/api/progress/${ids[title]}`, { locator: epub(percent), updatedAt: at, deviceName });

const rate = (title: string, rating: (typeof books.$inferInsert)["rating"]) =>
  db.update(books).set({ rating }).where(eq(books.id, ids[title]!)).run();

describe("reading progress", () => {
  it("syncs a position across devices for the same profile", async () => {
    const put = await save("Dad", "Thriller", 0.4, "2026-01-01T10:00:00Z", "Web");
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ status: "applied", progress: { percent: 0.4, deviceName: "Web" } });

    const get = await call("Dad", "GET", `/api/progress/${ids.Thriller}`);
    expect(get.json().progress).toMatchObject({ percent: 0.4, locator: epub(0.4), finished: false });
  });

  it("keeps the newest position when an offline device uploads an older one", async () => {
    await save("Dad", "Thriller", 0.6, "2026-01-02T10:00:00Z", "Web");
    const late = await save("Dad", "Thriller", 0.3, "2026-01-01T10:00:00Z", "Tablet");
    expect(late.json()).toMatchObject({ status: "stale", progress: { percent: 0.6, deviceName: "Web" } });

    const newer = await save("Dad", "Thriller", 0.7, Date.parse("2026-01-03T10:00:00Z"), "Tablet");
    expect(newer.json()).toMatchObject({ status: "applied", progress: { percent: 0.7 } });
  });

  it("clamps a device clock that runs in the future", async () => {
    const future = Date.now() + 365 * 24 * 3600 * 1000;
    const res = await save("Dad", "Thriller", 0.5, future);
    expect(res.json().progress.clientUpdatedAt).toBeLessThanOrEqual(Date.now());
    // A real later update still wins.
    await new Promise((r) => setTimeout(r, 5));
    expect((await save("Dad", "Thriller", 0.55, Date.now())).json().status).toBe("applied");
  });

  it("keeps each profile's progress separate", async () => {
    await save("Dad", "Picture Book", 0.5, "2026-01-01T10:00:00Z");
    const emma = await call("Emma", "GET", `/api/progress/${ids["Picture Book"]}`);
    expect(emma.json().progress).toBeNull();
  });

  it("returns 404 when a kid reads or saves progress on a locked book", async () => {
    expect((await save("Emma", "Thriller", 0.1, "2026-01-01T10:00:00Z")).statusCode).toBe(404);
    expect((await call("Emma", "GET", `/api/progress/${ids.Thriller}`)).statusCode).toBe(404);
    expect((await save("Emma", "Inbox Book", 0.1, "2026-01-01T10:00:00Z")).statusCode).toBe(404);
    expect((await call("Emma", "DELETE", `/api/progress/${ids.Thriller}`)).statusCode).toBe(404);
  });

  it("drops a book from the kid's synced progress once it's re-rated above their level", async () => {
    await save("Emma", "Picture Book", 0.2, "2026-01-01T10:00:00Z");
    rate("Picture Book", "teen");
    const list = await call("Emma", "GET", "/api/progress");
    expect(list.json().items).toEqual([]);
    expect((await call("Emma", "GET", `/api/progress/${ids["Picture Book"]}`)).statusCode).toBe(404);
  });

  it("returns only changes after the since cursor", async () => {
    await save("Dad", "Picture Book", 0.2, "2026-01-01T10:00:00Z");
    const first = (await call("Dad", "GET", "/api/progress")).json();
    expect(first.items).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 5));
    await save("Dad", "Thriller", 0.3, "2026-01-01T11:00:00Z");
    const next = (await call("Dad", "GET", `/api/progress?since=${first.serverTime}`)).json();
    expect(next.items.map((p: { bookId: string }) => p.bookId)).toEqual([ids.Thriller]);
  });

  it("applies an offline batch one update at a time", async () => {
    await save("Emma", "Bedtime Story", 0.9, "2026-01-05T10:00:00Z");
    const res = await call("Emma", "POST", "/api/progress/batch", {
      updates: [
        { bookId: ids["Picture Book"], locator: epub(0.5), updatedAt: "2026-01-02T10:00:00Z", deviceName: "Tablet" },
        { bookId: ids["Bedtime Story"], locator: epub(0.1), updatedAt: "2026-01-01T10:00:00Z", deviceName: "Tablet" },
        { bookId: ids.Thriller, locator: epub(0.5), updatedAt: "2026-01-02T10:00:00Z", deviceName: "Tablet" },
        { bookId: "no-such-book", locator: epub(0.5), updatedAt: "2026-01-02T10:00:00Z", deviceName: "Tablet" },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual([
      "applied",
      "stale",
      "not_found",
      "not_found",
    ]);
  });

  it("rejects a malformed locator with 400", async () => {
    const res = await call("Dad", "PUT", `/api/progress/${ids.Thriller}`, {
      locator: { kind: "epub", percent: 2 },
      updatedAt: "2026-01-01T10:00:00Z",
      deviceName: "Web",
    });
    expect(res.statusCode).toBe(400);
  });

  it("marks a book finished at the end and works out percent from page locators", async () => {
    const res = await call("Dad", "PUT", `/api/progress/${ids.Thriller}`, {
      locator: { kind: "page", page: 300, totalPages: 300 },
      updatedAt: "2026-01-01T10:00:00Z",
      deviceName: "Web",
    });
    expect(res.json().progress).toMatchObject({ percent: 1, finished: true });
  });

  it("requires sign-in", async () => {
    const res = await app.inject({ method: "GET", url: "/api/progress" });
    expect(res.statusCode).toBe(401);
  });
});

describe("bookmarks, highlights and stickers", () => {
  const create = (who: string, title: string, extra: Record<string, unknown> = {}) =>
    call(who, "POST", "/api/bookmarks", { bookId: ids[title], kind: "bookmark", locator: epub(0.1), ...extra });

  it("creates, edits and soft-deletes, and sync sees each change", async () => {
    const made = await create("Emma", "Picture Book", { kind: "sticker", text: "star", color: "#ffcc00" });
    expect(made.statusCode).toBe(201);
    const id = made.json().id as string;
    const cursor = (await call("Emma", "GET", "/api/bookmarks")).json().serverTime;

    await new Promise((r) => setTimeout(r, 5));
    const edited = await call("Emma", "PATCH", `/api/bookmarks/${id}`, { note: "my favourite page" });
    expect(edited.json()).toMatchObject({ note: "my favourite page", text: "star" });
    let changes = (await call("Emma", "GET", `/api/bookmarks?since=${cursor}`)).json().items;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id, note: "my favourite page", deletedAt: null });

    expect((await call("Emma", "DELETE", `/api/bookmarks/${id}`)).statusCode).toBe(204);
    const live = (await call("Emma", "GET", `/api/books/${ids["Picture Book"]}/bookmarks`)).json().items;
    expect(live).toEqual([]);
    changes = (await call("Emma", "GET", `/api/bookmarks?since=${cursor}`)).json().items;
    expect(changes[0].deletedAt).toEqual(expect.any(Number));
  });

  it("accepts a client-chosen id and treats a retried upload as a no-op", async () => {
    const id = crypto.randomUUID();
    expect((await create("Dad", "Thriller", { id })).statusCode).toBe(201);
    const again = await create("Dad", "Thriller", { id });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(id);
    expect((await create("Aunt", "Thriller", { id })).statusCode).toBe(409);
  });

  it("returns 404 for bookmarks on locked books and on other people's bookmarks", async () => {
    expect((await create("Emma", "Thriller")).statusCode).toBe(404);
    expect((await call("Emma", "GET", `/api/books/${ids.Thriller}/bookmarks`)).statusCode).toBe(404);

    const dads = (await create("Dad", "Picture Book")).json().id;
    expect((await call("Emma", "PATCH", `/api/bookmarks/${dads}`, { note: "hi" })).statusCode).toBe(404);
    expect((await call("Emma", "DELETE", `/api/bookmarks/${dads}`)).statusCode).toBe(404);
  });

  it("hides bookmarks on a book that was re-rated above the kid's level", async () => {
    const id = (await create("Emma", "Picture Book")).json().id;
    rate("Picture Book", "adult");
    expect((await call("Emma", "GET", "/api/bookmarks")).json().items).toEqual([]);
    expect((await call("Emma", "GET", "/api/bookmarks?since=0")).json().items).toEqual([]);
    expect((await call("Emma", "PATCH", `/api/bookmarks/${id}`, { note: "x" })).statusCode).toBe(404);
  });

  it("validates kind and color", async () => {
    expect((await create("Dad", "Thriller", { kind: "doodle" })).statusCode).toBe(400);
    expect((await create("Dad", "Thriller", { color: "red; drop table" })).statusCode).toBe(400);
  });
});

describe("shelves", () => {
  it("lists continue reading newest first, without finished or locked books", async () => {
    await save("Emma", "Picture Book", 0.3, "2026-01-01T10:00:00Z");
    await save("Emma", "Bedtime Story", 0.5, "2026-01-02T10:00:00Z");
    await call("Emma", "PUT", `/api/progress/${ids["Inbox Book"]}`, {
      locator: epub(0.5),
      updatedAt: "2026-01-03T10:00:00Z",
      deviceName: "Tablet",
    });
    let shelf = (await call("Emma", "GET", "/api/shelves/continue")).json().items;
    expect(shelf.map((i: { book: { title: string } }) => i.book.title)).toEqual(["Bedtime Story", "Picture Book"]);

    await call("Emma", "PUT", `/api/progress/${ids["Bedtime Story"]}`, {
      locator: epub(1),
      updatedAt: "2026-01-04T10:00:00Z",
      deviceName: "Tablet",
    });
    rate("Picture Book", "adult");
    shelf = (await call("Emma", "GET", "/api/shelves/continue")).json().items;
    expect(shelf).toEqual([]);
    const finished = (await call("Emma", "GET", "/api/shelves/finished")).json().items;
    expect(finished.map((i: { book: { title: string } }) => i.book.title)).toEqual(["Bedtime Story"]);
  });

  it("lets a linked parent fill a kid's shelf, and the kid sees it", async () => {
    const put = await call("Dad", "PUT", `/api/shelves/kids/${ids.Emma}/books/${ids["Picture Book"]}`, {
      storyteller: true,
    });
    expect(put.statusCode).toBe(204);
    await call("Dad", "PUT", `/api/shelves/kids/${ids.Emma}/books/${ids["Bedtime Story"]}`);
    await save("Emma", "Picture Book", 0.4, "2026-01-01T10:00:00Z");

    const mine = (await call("Emma", "GET", "/api/shelves/kids/me")).json();
    expect(mine.kid.displayName).toBe("Emma");
    expect(mine.items).toHaveLength(2);
    const picture = mine.items.find((i: { book: { title: string } }) => i.book.title === "Picture Book");
    expect(picture).toMatchObject({ storyteller: true, progress: { percent: 0.4 } });

    const story = (await call("Emma", "GET", "/api/shelves/kids/me?storyteller=true")).json().items;
    expect(story.map((i: { book: { title: string } }) => i.book.title)).toEqual(["Picture Book"]);
  });

  it("refuses a book above the kid's level and hides it if re-rated later", async () => {
    const res = await call("Dad", "PUT", `/api/shelves/kids/${ids.Emma}/books/${ids.Thriller}`);
    expect(res.statusCode).toBe(422);
    // An admin can see inbox books, but the kid can't, so it can't go on their shelf either.
    const inbox = await call("Admin", "PUT", `/api/shelves/kids/${ids.Emma}/books/${ids["Inbox Book"]}`);
    expect(inbox.statusCode).toBe(422);
    expect(inbox.json().error).toMatch(/inbox/);
    expect(res.json().error).toMatch(/reading level/);

    await call("Dad", "PUT", `/api/shelves/kids/${ids.Emma}/books/${ids["Picture Book"]}`);
    rate("Picture Book", "teen");
    expect((await call("Emma", "GET", "/api/shelves/kids/me")).json().items).toEqual([]);
    expect((await call("Dad", "GET", `/api/shelves/kids/${ids.Emma}`)).json().items).toEqual([]);
  });

  it("only lets linked parents and admins manage a kid's shelf", async () => {
    const url = `/api/shelves/kids/${ids.Emma}/books/${ids["Picture Book"]}`;
    expect((await call("Emma", "PUT", url)).statusCode).toBe(403);
    expect((await call("Emma", "PUT", `/api/shelves/kids/me/books/${ids["Picture Book"]}`)).statusCode).toBe(403);
    expect((await call("Aunt", "PUT", url)).statusCode).toBe(403);
    expect((await call("Admin", "PUT", url)).statusCode).toBe(204);
    expect((await call("Emma", "DELETE", url)).statusCode).toBe(403);
    expect((await call("Dad", "DELETE", url)).statusCode).toBe(204);
  });

  it("hides a kid's shelf from other kids and unlinked adults", async () => {
    expect((await call("Leo", "GET", `/api/shelves/kids/${ids.Emma}`)).statusCode).toBe(404);
    expect((await call("Aunt", "GET", `/api/shelves/kids/${ids.Emma}`)).statusCode).toBe(404);
    expect((await call("Dad", "GET", `/api/shelves/kids/${ids.Dad}`)).statusCode).toBe(404);
    expect((await call("Dad", "GET", "/api/shelves/kids/me")).statusCode).toBe(404);
  });
});
