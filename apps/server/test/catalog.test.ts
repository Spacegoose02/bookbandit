import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { openDb, type Db } from "../src/db/client.js";
import { loadConfig } from "../src/config.js";
import {
  authors,
  bookAuthors,
  bookFiles,
  books,
  bookSeries,
  bookTags,
  collectionBooks,
  collections,
  households,
  kidShelf,
  parentLinks,
  readingProgress,
  series,
  tags,
  userIdentities,
  users,
} from "../src/db/schema.js";

let app: FastifyInstance;
let db: Db;
let close: () => void;
const ids: Record<string, string> = {};

const KID = "kid@example.com";
const DAD = "dad@example.com";

beforeEach(async () => {
  ({ db, close } = openDb(":memory:"));
  const [home] = db.insert(households).values({ name: "Home" }).returning().all();
  const [other] = db.insert(households).values({ name: "Neighbors" }).returning().all();
  const [dad] = db.insert(users).values({ householdId: home!.id, displayName: "Dad", role: "parent" }).returning().all();
  const [kid] = db
    .insert(users)
    .values({
      householdId: home!.id,
      displayName: "Emma",
      role: "kid",
      birthYear: new Date().getUTCFullYear() - 8, // 7 by the conservative age rule
      kidSignInMethod: "google",
    })
    .returning()
    .all();
  db.insert(parentLinks).values({ parentId: dad!.id, kidId: kid!.id }).run();
  db.insert(userIdentities)
    .values([
      { userId: dad!.id, provider: "tinyauth", subject: DAD },
      { userId: kid!.id, provider: "tinyauth", subject: KID },
    ])
    .run();
  ids.dad = dad!.id;
  ids.kid = kid!.id;

  const add = (title: string, rating: (typeof books.$inferInsert)["rating"], year: number, addedAt: number) => {
    const [b] = db
      .insert(books)
      .values({ title, sortTitle: title.toLowerCase(), rating, approved: true, publishedYear: year, addedAt })
      .returning()
      .all();
    ids[title] = b!.id;
    return b!.id;
  };
  const dino = add("Dinosaur Picnic", "kids", 2015, 1000);
  const dino2 = add("Dinosaur Picnic 2", "kids", 2018, 2000);
  const owl = add("100% Owl", "kids", 2020, 3000);
  const thriller = add("Night Thriller", "adult", 2019, 4000);
  const spicy = add("Spicy Romance", "explicit", 2021, 5000);

  const [rex] = db.insert(authors).values({ name: "Rex Writer", sortName: "Writer, Rex" }).returning().all();
  const [noir] = db.insert(authors).values({ name: "Noir Author", sortName: "Author, Noir" }).returning().all();
  ids.rex = rex!.id;
  ids.noir = noir!.id;
  db.insert(bookAuthors)
    .values([
      { bookId: dino, authorId: rex!.id },
      { bookId: dino2, authorId: rex!.id },
      { bookId: thriller, authorId: noir!.id },
    ])
    .run();

  const [s] = db.insert(series).values({ name: "Dinosaur Days" }).returning().all();
  ids.series = s!.id;
  db.insert(bookSeries)
    .values([
      { bookId: dino2, seriesId: s!.id, position: 2 },
      { bookId: dino, seriesId: s!.id, position: 1 },
    ])
    .run();

  db.insert(bookFiles)
    .values({ bookId: dino, relPath: "Rex Writer/Dinosaur Picnic.epub", format: "epub", sizeBytes: 1234 })
    .run();

  const [kidsTag] = db.insert(tags).values({ name: "Kids", kind: "section" }).returning().all();
  const [romanceTag] = db.insert(tags).values({ name: "Romance", kind: "section" }).returning().all();
  ids.kidsTag = kidsTag!.id;
  ids.romanceTag = romanceTag!.id;
  db.insert(bookTags)
    .values([
      { bookId: dino, tagId: kidsTag!.id },
      { bookId: owl, tagId: kidsTag!.id },
      { bookId: spicy, tagId: romanceTag!.id },
    ])
    .run();

  const [shared] = db.insert(collections).values({ householdId: home!.id, name: "Bedtime" }).returning().all();
  const [mine] = db
    .insert(collections)
    .values({ householdId: home!.id, name: "Dad's picks", ownerId: dad!.id })
    .returning()
    .all();
  const [theirs] = db.insert(collections).values({ householdId: other!.id, name: "Next door" }).returning().all();
  ids.shared = shared!.id;
  ids.mine = mine!.id;
  ids.theirs = theirs!.id;
  db.insert(collectionBooks)
    .values([
      { collectionId: shared!.id, bookId: owl },
      { collectionId: mine!.id, bookId: thriller },
      { collectionId: theirs!.id, bookId: dino },
    ])
    .run();

  db.insert(kidShelf).values({ kidId: kid!.id, bookId: owl, addedBy: dad!.id }).run();
  db.insert(readingProgress)
    .values({
      userId: kid!.id,
      bookId: dino,
      locator: { kind: "epub", cfi: "epubcfi(/6/4)", percent: 0.4 },
      percent: 0.4,
      clientUpdatedAt: 1,
      serverUpdatedAt: 1,
    })
    .run();

  const config = loadConfig({ TRUSTED_PROXIES: "127.0.0.1", LOG_LEVEL: "error" } as NodeJS.ProcessEnv);
  app = await buildApp(config, db);
});

afterEach(async () => {
  await app.close();
  close();
});

async function get(email: string, url: string) {
  return app.inject({ method: "GET", url, headers: { "remote-email": email } });
}

async function titles(email: string, url: string) {
  const res = await get(email, url);
  expect(res.statusCode).toBe(200);
  return (res.json().items as { title: string }[]).map((b) => b.title);
}

describe("GET /api/books filters", () => {
  it("returns only books the kid may see, with a matching total", async () => {
    const res = await get(KID, "/api/books");
    expect(res.json().total).toBe(3);
    expect(res.json().items.map((b: { title: string }) => b.title)).toEqual([
      "100% Owl",
      "Dinosaur Picnic",
      "Dinosaur Picnic 2",
    ]);
  });

  it("can't widen the lock with ?ratings=", async () => {
    expect(await titles(KID, "/api/books?ratings=adult,explicit")).toEqual([]);
    expect(await titles(DAD, "/api/books?ratings=explicit")).toEqual([]);
    expect(await titles(DAD, "/api/books?ratings=adult")).toEqual(["Night Thriller"]);
  });

  it("searches titles and author names, treating % literally", async () => {
    expect(await titles(KID, "/api/books?q=picnic")).toEqual(["Dinosaur Picnic", "Dinosaur Picnic 2"]);
    expect(await titles(KID, "/api/books?q=rex")).toEqual(["Dinosaur Picnic", "Dinosaur Picnic 2"]);
    expect(await titles(KID, `/api/books?q=${encodeURIComponent("100%")}`)).toEqual(["100% Owl"]);
    expect(await titles(KID, "/api/books?q=noir")).toEqual([]);
  });

  it("filters by author and year range and sorts", async () => {
    expect(await titles(DAD, `/api/books?author=${ids.rex}`)).toEqual(["Dinosaur Picnic", "Dinosaur Picnic 2"]);
    expect(await titles(DAD, "/api/books?yearFrom=2016&yearTo=2020&sort=year")).toEqual([
      "Dinosaur Picnic 2",
      "Night Thriller",
      "100% Owl",
    ]);
    expect(await titles(DAD, "/api/books?sort=added")).toEqual([
      "Night Thriller",
      "100% Owl",
      "Dinosaur Picnic 2",
      "Dinosaur Picnic",
    ]);
  });

  it("includes authors, series and the reader's percent", async () => {
    const res = await get(KID, `/api/books?shelf=series:${ids.series}&sort=year`);
    const [first] = res.json().items;
    expect(first.authors).toEqual([{ id: ids.rex, name: "Rex Writer" }]);
    expect(first.series).toEqual([{ id: ids.series, name: "Dinosaur Days", position: 1 }]);
    expect(first.percent).toBe(0.4);
  });

  it("filters by shelf", async () => {
    expect(await titles(KID, "/api/books?shelf=continue")).toEqual(["Dinosaur Picnic"]);
    expect(await titles(KID, "/api/books?shelf=kid")).toEqual(["100% Owl"]);
    expect(await titles(KID, `/api/books?shelf=tag:${ids.kidsTag}`)).toEqual(["100% Owl", "Dinosaur Picnic"]);
    expect(await titles(DAD, `/api/books?shelf=tag:${ids.romanceTag}`)).toEqual([]);
    expect(await titles(DAD, `/api/books?shelf=collection:${ids.mine}`)).toEqual(["Night Thriller"]);
    expect(await titles(KID, `/api/books?shelf=collection:${ids.mine}`)).toEqual([]);
    expect(await titles(DAD, `/api/books?shelf=collection:${ids.theirs}`)).toEqual([]);
  });

  it("rejects an unknown shelf", async () => {
    expect((await get(KID, "/api/books?shelf=nope")).statusCode).toBe(400);
    expect((await get(KID, "/api/books?shelf=series:")).statusCode).toBe(400);
  });
});

describe("GET /api/books/:id", () => {
  it("adds authors, series, files and percent without exposing file paths", async () => {
    const res = await get(KID, `/api/books/${ids["Dinosaur Picnic"]}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authors).toEqual([{ id: ids.rex, name: "Rex Writer" }]);
    expect(body.series[0].name).toBe("Dinosaur Days");
    expect(body.percent).toBe(0.4);
    expect(body.files).toEqual([{ id: expect.any(String), format: "epub", sizeBytes: 1234 }]);
    expect(JSON.stringify(body)).not.toContain("relPath");
  });

  it("is a 404 for a locked book", async () => {
    expect((await get(KID, `/api/books/${ids["Night Thriller"]}`)).statusCode).toBe(404);
    expect((await get(DAD, `/api/books/${ids["Spicy Romance"]}`)).statusCode).toBe(404);
  });
});

describe("GET /api/authors", () => {
  it("lists only authors with a book the reader can see", async () => {
    const kid = (await get(KID, "/api/authors")).json().items;
    expect(kid).toEqual([{ id: ids.rex, name: "Rex Writer" }]);
    const dad = (await get(DAD, "/api/authors?q=noir")).json().items;
    expect(dad).toEqual([{ id: ids.noir, name: "Noir Author" }]);
  });
});

describe("GET /api/shelves", () => {
  it("gives a kid their shelves and nothing above their level", async () => {
    const res = await get(KID, "/api/shelves");
    expect(res.statusCode).toBe(200);
    const shelves = res.json().items as { id: string; kind: string; books: { title: string }[] }[];
    expect(shelves.map((s) => s.id)).toEqual([
      "continue",
      "kid",
      "recent",
      `tag:${ids.kidsTag}`,
      `collection:${ids.shared}`,
      `series:${ids.series}`,
    ]);
    const all = shelves.flatMap((s) => s.books.map((b) => b.title));
    expect(all).not.toContain("Night Thriller");
    expect(all).not.toContain("Spicy Romance");
  });

  it("leaves out shelves whose books are all locked", async () => {
    const shelves = (await get(DAD, "/api/shelves")).json().items as { id: string }[];
    const shelfIds = shelves.map((s) => s.id);
    expect(shelfIds).not.toContain(`tag:${ids.romanceTag}`);
    expect(shelfIds).not.toContain(`collection:${ids.theirs}`);
    expect(shelfIds).toContain(`collection:${ids.mine}`);
    expect(shelfIds).not.toContain("kid");
  });

  it("needs a signed-in reader", async () => {
    expect((await app.inject({ method: "GET", url: "/api/shelves" })).statusCode).toBe(401);
  });
});
