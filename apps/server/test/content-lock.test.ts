import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { loadConfig } from "../src/config.js";
import { books, households, parentLinks, userIdentities, users } from "../src/db/schema.js";

let app: FastifyInstance;
let db: Db;
let close: () => void;

const kidBirthYear = new Date().getUTCFullYear() - 8; // 7 by our conservative age rule

beforeEach(async () => {
  ({ db, close } = openDb(":memory:"));
  const [home] = db.insert(households).values({ name: "Home" }).returning().all();
  const [parent] = db
    .insert(users)
    .values({ householdId: home!.id, displayName: "Dad", role: "parent" })
    .returning()
    .all();
  const [kid] = db
    .insert(users)
    .values({ householdId: home!.id, displayName: "Emma", role: "kid", birthYear: kidBirthYear, kidSignInMethod: "google" })
    .returning()
    .all();
  db.insert(parentLinks).values({ parentId: parent!.id, kidId: kid!.id }).run();
  db.insert(userIdentities)
    .values([
      { userId: parent!.id, provider: "tinyauth", subject: "dad@example.com" },
      { userId: kid!.id, provider: "tinyauth", subject: "emma@example.com" },
    ])
    .run();
  const book = (title: string, rating: (typeof books.$inferInsert)["rating"], approved = true) => ({
    title,
    sortTitle: title.toLowerCase(),
    rating,
    approved,
  });
  db.insert(books)
    .values([
      book("Picture Book", "kids"),
      book("Chapter Book", "middle_grade"),
      book("Teen Novel", "teen"),
      book("Thriller", "adult"),
      book("Unrated Download", null),
      book("Explicit Romance", "explicit"),
      book("Inbox Book", "kids", false),
    ])
    .run();

  const config = loadConfig({ TRUSTED_PROXIES: "127.0.0.1", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  app = await buildApp(config, db);
});

afterEach(async () => {
  await app.close();
  close();
});

const titlesFor = async (email: string) => {
  const res = await app.inject({ method: "GET", url: "/api/books", headers: { "remote-email": email } });
  expect(res.statusCode).toBe(200);
  return (res.json().items as { title: string }[]).map((b) => b.title).sort();
};

describe("content lock", () => {
  it("shows a 7-year-old only approved kids books", async () => {
    expect(await titlesFor("emma@example.com")).toEqual(["Picture Book"]);
  });

  it("shows a parent adult and unrated books but not explicit", async () => {
    expect(await titlesFor("dad@example.com")).toEqual([
      "Chapter Book",
      "Picture Book",
      "Teen Novel",
      "Thriller",
      "Unrated Download",
    ]);
  });

  it("returns 404 when a kid opens a locked book directly", async () => {
    const thriller = db.select().from(books).all().find((b) => b.title === "Thriller")!;
    const res = await app.inject({
      method: "GET",
      url: `/api/books/${thriller.id}`,
      headers: { "remote-email": "emma@example.com" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("ignores the auth header from an untrusted address", async () => {
    await app.close();
    const config = loadConfig({ TRUSTED_PROXIES: "10.0.0.5", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
    app = await buildApp(config, db);
    const res = await app.inject({ method: "GET", url: "/api/books", headers: { "remote-email": "dad@example.com" } });
    expect(res.statusCode).toBe(401);
  });
});
