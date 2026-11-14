import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  authors,
  bookAuthors,
  books,
  bookSeries,
  bookTags,
  readingProgress,
  series,
  settings,
  tags,
} from "../src/db/schema.js";
import { applySubjects, setMinBooks, upgradeCategories } from "../src/discover/category-store.js";
import { setBookSeries } from "../src/library/store.js";
import { family, type Family } from "./helpers.js";

let f: Family;
let calls: string[];
let olFails = false;
const NOW = Date.UTC(2026, 10, 14);

const OL_WEEKLY = {
  works: [
    { key: "/works/OL1W", title: "Grown-up Thriller", author_name: ["Ann Adult"], first_publish_year: 2020, cover_i: 11 },
    { key: "/works/OL2W", title: "The Happy Hippo", author_name: ["Kay Kid"], first_publish_year: 2019 },
    { key: "/works/OL3W", title: "Kindle Saga", author_name: ["Kim Kindle"] },
    { key: "/works/OL4W", title: "Not Here Yet", author_name: ["Nobody"], cover_i: 44 },
    { key: "/works/OL5W", title: "Waiting In Inbox", author_name: ["Ivy Inbox"] },
    { key: "/works/OL6W", title: "Happy Hippo", author_name: ["Someone Else"] },
  ],
};

function fakeFetch(url: string): Promise<Response> {
  calls.push(url);
  if (url.includes("openlibrary.org/trending/weekly")) {
    if (olFails) return Promise.resolve(new Response("down", { status: 503 }));
    return Promise.resolve(Response.json(OL_WEEKLY));
  }
  if (url.includes("openlibrary.org/trending/yearly")) return Promise.resolve(Response.json({ works: [] }));
  if (url.includes("hardcover")) return Promise.resolve(Response.json({ data: { books_trending: { ids: [] } } }));
  return Promise.resolve(new Response("nope", { status: 404 }));
}

function addAuthor(bookId: string, name: string) {
  db().insert(authors).values({ name, sortName: name }).onConflictDoNothing().run();
  const a = db().select().from(authors).where(eq(authors.name, name)).get()!;
  db().insert(bookAuthors).values({ bookId, authorId: a.id }).run();
}
const db = () => f.db;

let ids: Record<string, string>;

beforeEach(async () => {
  calls = [];
  olFails = false;
  f = await family({ discover: { fetchImpl: (u) => fakeFetch(String(u)), now: () => NOW } });
  ids = {
    thriller: f.book("Grown-up Thriller", "adult", { openLibraryId: "OL1W" }),
    hippo: f.book("The Happy Hippo", "kids", { sortTitle: "happy hippo, the" }),
    kindle: f.book("Kindle Saga", "teen", { kindleOnly: true, kindleAsin: "B000KINDLE" }),
    inbox: f.book("Waiting In Inbox", "kids", { approved: false }),
    unrated: f.book("Mystery Unrated", null),
  };
  addAuthor(ids.hippo!, "Kay Kid");
  addAuthor(ids.kindle!, "Kim Kindle");
});
afterEach(async () => {
  await f.close();
});

const get = (url: string, who: "admin" | "parent" | "adult" | "kid") =>
  f.app.inject({ method: "GET", url, headers: f.as(who) });

describe("GET /api/discover", () => {
  it("marks trending books In library, On Kindle or Request it for an adult", async () => {
    const res = await get("/api/discover", "adult");
    expect(res.statusCode).toBe(200);
    const list = res.json().lists.find((l: { id: string }) => l.id === "openlibrary-weekly");
    const byTitle = Object.fromEntries(list.items.map((i: { title: string }) => [i.title, i]));
    expect(byTitle["Grown-up Thriller"]).toMatchObject({ status: "library", bookId: ids.thriller });
    expect(byTitle["The Happy Hippo"]).toMatchObject({ status: "library", bookId: ids.hippo });
    expect(byTitle["Kindle Saga"]).toMatchObject({ status: "kindle", bookId: ids.kindle, onKindle: true });
    expect(byTitle["Not Here Yet"]).toMatchObject({ status: "request", bookId: null });
    expect(byTitle["Not Here Yet"].coverUrl).toContain("covers.openlibrary.org");
    // A book still in the admin inbox isn't visible yet, so it can't be matched.
    expect(byTitle["Waiting In Inbox"]).toMatchObject({ status: "request", bookId: null });
    // Same title, different author: not a match.
    expect(byTitle["Happy Hippo"]).toMatchObject({ status: "request", bookId: null });
    // No Hardcover token: no Hardcover list and no Hardcover call.
    expect(res.json().lists.some((l: { id: string }) => l.id === "hardcover-trending")).toBe(false);
    expect(calls.some((c) => c.includes("hardcover"))).toBe(false);
  });

  it("only shows a kid the outside books already on their side of the content lock", async () => {
    const res = await get("/api/discover", "kid");
    expect(res.statusCode).toBe(200);
    expect(res.json().requests).toBe(false);
    const items = res.json().lists.flatMap((l: { items: unknown[] }) => l.items);
    expect(items.map((i: { title: string }) => i.title)).toEqual(["The Happy Hippo"]);
    expect(JSON.stringify(res.json())).not.toContain(ids.thriller);
    expect(JSON.stringify(res.json())).not.toContain("Not Here Yet");
  });

  it("caches outside lists and survives a failing source", async () => {
    await get("/api/discover", "adult");
    await get("/api/discover", "parent");
    expect(calls.filter((c) => c.includes("trending/weekly"))).toHaveLength(1);

    await f.close();
    calls = [];
    olFails = true;
    f = await family({ discover: { fetchImpl: (u) => fakeFetch(String(u)), now: () => NOW } });
    const res = await get("/api/discover", "adult");
    expect(res.statusCode).toBe(200);
    const weekly = res.json().lists.find((l: { id: string }) => l.id === "openlibrary-weekly");
    expect(weekly.items).toEqual([]);
    expect(weekly.error).toMatch(/503/);
  });

  it("makes no outside calls when METADATA_ONLINE=false", async () => {
    await f.close();
    calls = [];
    f = await family({ discover: { fetchImpl: (u) => fakeFetch(String(u)) } }, { METADATA_ONLINE: "false" });
    const res = await get("/api/discover", "adult");
    expect(res.json().online).toBe(false);
    expect(calls).toEqual([]);
  });

  it("builds Popular in your family through the content lock", async () => {
    const hippo = f.book("Hippo Two", "kids");
    for (const [user, book] of [
      [f.ids.parent, ids.thriller],
      [f.ids.adult, ids.thriller],
      [f.ids.kid, hippo],
    ] as const)
      f.db
        .insert(readingProgress)
        .values({ userId: user, bookId: book!, locator: { kind: "epub", cfi: "x", percent: 0.3 }, percent: 0.3, clientUpdatedAt: NOW, serverUpdatedAt: NOW })
        .run();
    const adult = (await get("/api/discover", "adult")).json().lists.find((l: { id: string }) => l.id === "family");
    expect(adult.items.map((i: { bookId: string }) => i.bookId)).toEqual([ids.thriller, hippo]);
    const kid = (await get("/api/discover", "kid")).json().lists.find((l: { id: string }) => l.id === "family");
    expect(kid.items.map((i: { bookId: string }) => i.bookId)).toEqual([hippo]);
  });
});

describe("series", () => {
  let mixed: string;
  let adultOnly: string;
  beforeEach(() => {
    [{ id: mixed }, { id: adultOnly }] = f.db
      .insert(series)
      .values([{ name: "Hippo Tales" }, { name: "Dark Nights" }])
      .returning()
      .all() as [{ id: string }, { id: string }];
    const b2 = f.book("Hippo Goes Home", "kids", { publishedYear: 2021 });
    const b15 = f.book("Hippo Side Story", "kids");
    const grown = f.book("Hippo For Grown-ups", "adult");
    f.db
      .insert(bookSeries)
      .values([
        { seriesId: mixed, bookId: b2, position: 2 },
        { seriesId: mixed, bookId: ids.hippo!, position: 1 },
        { seriesId: mixed, bookId: b15, position: 1.5 },
        { seriesId: mixed, bookId: grown, position: 3 },
        { seriesId: adultOnly, bookId: ids.thriller!, position: 1 },
      ])
      .run();
  });

  it("lists books in reading order, filtered by the content lock", async () => {
    const adult = await get(`/api/series/${mixed}`, "adult");
    expect(adult.json().books.map((b: { title: string }) => b.title)).toEqual([
      "The Happy Hippo",
      "Hippo Side Story",
      "Hippo Goes Home",
      "Hippo For Grown-ups",
    ]);
    const kid = await get(`/api/series/${mixed}`, "kid");
    expect(kid.json().books.map((b: { position: number }) => b.position)).toEqual([1, 1.5, 2]);
  });

  it("404s a series whose books are all locked, and leaves it out of the list", async () => {
    expect((await get(`/api/series/${adultOnly}`, "kid")).statusCode).toBe(404);
    expect((await get(`/api/series/does-not-exist`, "adult")).statusCode).toBe(404);
    const kidList = (await get("/api/series", "kid")).json();
    expect(kidList.items.map((s: { name: string }) => s.name)).toEqual(["Hippo Tales"]);
    expect(kidList.items[0].bookCount).toBe(3);
    expect(kidList.total).toBe(1);
    const adultList = (await get("/api/series", "adult")).json();
    expect(adultList.items.map((s: { name: string }) => s.name)).toEqual(["Hippo Tales", "Dark Nights"]);
    expect(adultList.items[0].bookCount).toBe(4);
  });

  it("lets an admin create, reorder, rename and delete a series, and a rescan keeps it", async () => {
    const make = await f.app.inject({
      method: "POST",
      url: "/api/series",
      headers: f.as("admin"),
      payload: { name: "  Family Favorites ", books: [{ bookId: ids.hippo }, { bookId: ids.thriller }] },
    });
    expect(make.statusCode).toBe(201);
    const id = make.json().id as string;
    expect(make.json()).toMatchObject({ name: "Family Favorites", adminManaged: true });

    const reorder = await f.app.inject({
      method: "PUT",
      url: `/api/series/${id}/books`,
      headers: f.as("admin"),
      payload: { books: [{ bookId: ids.thriller }, { bookId: ids.hippo }] },
    });
    expect(reorder.statusCode).toBe(200);
    expect(reorder.json().books.map((b: { id: string; position: number }) => [b.id, b.position])).toEqual([
      [ids.thriller, 1],
      [ids.hippo, 2],
    ]);

    // Metadata from a rescan can't move a book out of an admin-managed series.
    f.db.transaction((tx) => setBookSeries(tx, ids.thriller!, "Some Other Series", 7));
    expect(f.db.select().from(bookSeries).where(eq(bookSeries.bookId, ids.thriller!)).all()).toHaveLength(2);

    const rename = await f.app.inject({
      method: "PATCH",
      url: `/api/series/${id}`,
      headers: f.as("admin"),
      payload: { name: "Favorites", description: "Read every summer" },
    });
    expect(rename.json()).toMatchObject({ name: "Favorites", description: "Read every summer" });

    const bad = await f.app.inject({
      method: "PUT",
      url: `/api/series/${id}/books`,
      headers: f.as("admin"),
      payload: { books: [{ bookId: "nope" }] },
    });
    expect(bad.statusCode).toBe(400);

    const del = await f.app.inject({ method: "DELETE", url: `/api/series/${id}`, headers: f.as("admin") });
    expect(del.statusCode).toBe(204);
    expect((await get(`/api/series/${id}`, "admin")).statusCode).toBe(404);
  });

  it("keeps series editing admin-only", async () => {
    for (const who of ["parent", "adult", "kid"] as const) {
      const create = await f.app.inject({ method: "POST", url: "/api/series", headers: f.as(who), payload: { name: "X" } });
      expect(create.statusCode).toBe(403);
      const reorder = await f.app.inject({
        method: "PUT",
        url: `/api/series/${mixed}/books`,
        headers: f.as(who),
        payload: { books: [] },
      });
      expect(reorder.statusCode).toBe(403);
      const del = await f.app.inject({ method: "DELETE", url: `/api/series/${mixed}`, headers: f.as(who) });
      expect(del.statusCode).toBe(403);
    }
  });
});

describe("categories", () => {
  let cookbooks: string;
  let horror: string;
  beforeEach(() => {
    [{ id: cookbooks }, { id: horror }] = f.db
      .insert(tags)
      .values([
        { name: "Cookbooks", kind: "section" },
        { name: "Horror", kind: "genre" },
      ])
      .returning()
      .all() as [{ id: string }, { id: string }];
    const kidsCook = f.book("Pancakes for Kids", "kids");
    const soup = f.book("Weeknight Soups", "adult");
    f.db
      .insert(bookTags)
      .values([
        { tagId: cookbooks, bookId: kidsCook },
        { tagId: cookbooks, bookId: soup },
        { tagId: horror, bookId: ids.thriller! },
      ])
      .run();
    ids.soup = soup;
    ids.kidsCook = kidsCook;
  });

  it("counts only visible books and hides categories with none", async () => {
    const kid = (await get("/api/categories", "kid")).json().items;
    expect(kid.map((c: { name: string; bookCount: number }) => [c.name, c.bookCount])).toEqual([["Cookbooks", 1]]);
    expect(kid[0].cookbook).toBe(true);
    expect(kid[0].books.map((b: { id: string }) => b.id)).toEqual([ids.kidsCook]);
    // Horror has one book, under the default minimum of 3 for genre categories.
    const adult = (await get("/api/categories", "adult")).json().items;
    expect(adult.map((c: { name: string; bookCount: number }) => [c.name, c.bookCount])).toEqual([["Cookbooks", 2]]);
    setMinBooks(f.db, 1);
    const all = (await get("/api/categories", "adult")).json().items;
    expect(all.map((c: { name: string; bookCount: number }) => [c.name, c.bookCount])).toEqual([
      ["Cookbooks", 2],
      ["Horror", 1],
    ]);
    // Kids still don't see a category whose only book is locked for them.
    expect((await get("/api/categories", "kid")).json().items.map((c: { name: string }) => c.name)).toEqual(["Cookbooks"]);
  });

  it("never lists raw subjects or hidden categories, on the page, book chips or OPDS", async () => {
    setMinBooks(f.db, 1);
    const [subject] = f.db.insert(tags).values({ name: "Haunted houses", kind: "subject" }).returning().all();
    f.db.insert(bookTags).values({ tagId: subject!.id, bookId: ids.thriller! }).run();
    const names = async () => (await get("/api/categories", "adult")).json().items.map((c: { name: string }) => c.name);
    expect(await names()).toEqual(["Cookbooks", "Horror"]);
    const hide = await f.app.inject({ method: "PATCH", url: `/api/categories/${horror}`, headers: f.as("admin"), payload: { hidden: true } });
    expect(hide.statusCode).toBe(200);
    expect(await names()).toEqual(["Cookbooks"]);
    expect((await get(`/api/books/${ids.thriller}/categories`, "adult")).json().items).toEqual([]);
    // Still reachable by id, and the books keep the tag.
    expect((await get(`/api/categories/${horror}`, "adult")).json().total).toBe(1);
    expect(
      (await f.app.inject({ method: "PATCH", url: `/api/categories/${horror}`, headers: f.as("parent"), payload: { hidden: false } }))
        .statusCode,
    ).toBe(403);
  });

  it("lets an admin rename, merge, promote and list categories, and a rescan respects it", async () => {
    setMinBooks(f.db, 1);
    const admin = f.as("admin");
    // Rename: the old name now points at the renamed category.
    const renamed = await f.app.inject({ method: "PATCH", url: `/api/categories/${horror}`, headers: admin, payload: { name: "Scary Stories" } });
    expect(renamed.json()).toMatchObject({ id: horror, name: "Scary Stories", merged: false });
    f.db.transaction((tx) => applySubjects(tx, ids.hippo!, ["Horror fiction", "Horror"]));
    const scary = (await get(`/api/categories/${horror}`, "adult")).json();
    expect(scary.items.map((b: { id: string }) => b.id).sort()).toEqual([ids.thriller, ids.hippo].sort());
    expect(f.db.select().from(tags).where(eq(tags.name, "Horror")).all().filter((t) => t.kind === "genre")).toEqual([]);

    // Merge a subject into the category: books move, the subject goes, and its name is remembered.
    const [spooky] = f.db.insert(tags).values({ name: "Spooky", kind: "subject" }).returning().all();
    f.db.insert(bookTags).values({ tagId: spooky!.id, bookId: ids.soup! }).run();
    const merged = await f.app.inject({ method: "POST", url: `/api/categories/${spooky!.id}/merge`, headers: admin, payload: { into: horror } });
    expect(merged.json()).toEqual({ id: horror, bookCount: 3 });
    expect(f.db.select().from(tags).where(eq(tags.id, spooky!.id)).get()).toBeUndefined();
    f.db.transaction((tx) => applySubjects(tx, ids.kidsCook!, ["spookies"]));
    expect((await get(`/api/categories/${horror}`, "adult")).json().total).toBe(4);

    // Renaming onto an existing name merges instead.
    const [other] = f.db.insert(tags).values({ name: "Ghost stories", kind: "genre" }).returning().all();
    const onto = await f.app.inject({ method: "PATCH", url: `/api/categories/${other!.id}`, headers: admin, payload: { name: "scary story" } });
    expect(onto.json()).toMatchObject({ id: horror, merged: true });

    // Promote a subject to a category.
    const [dragons] = f.db.insert(tags).values({ name: "Dragons", kind: "subject" }).returning().all();
    f.db.insert(bookTags).values({ tagId: dragons!.id, bookId: ids.thriller! }).run();
    await f.app.inject({ method: "PATCH", url: `/api/categories/${dragons!.id}`, headers: admin, payload: { kind: "genre" } });
    expect((await get("/api/categories", "adult")).json().items.map((c: { name: string }) => c.name)).toContain("Dragons");

    const list = await f.app.inject({ method: "GET", url: "/api/admin/categories?kind=genre", headers: admin });
    expect(list.json().minBooks).toBe(1);
    expect(list.json().items.find((c: { id: string }) => c.id === horror)).toMatchObject({
      name: "Scary Stories",
      bookCount: 4,
      hidden: false,
      shown: true,
      aliases: expect.arrayContaining(["horror", "spooky", "ghost story"]),
    });
    expect((await f.app.inject({ method: "GET", url: "/api/admin/categories", headers: f.as("parent") })).statusCode).toBe(403);
    const minBooks = await f.app.inject({ method: "PUT", url: "/api/admin/categories/settings", headers: admin, payload: { minBooks: 5 } });
    expect(minBooks.json()).toEqual({ minBooks: 5 });
  });

  it("files books under curated categories from their subjects, rebuildable by an admin", async () => {
    f.db.transaction((tx) => {
      applySubjects(tx, ids.thriller!, ["Fiction", "Fiction / Thrillers / Suspense", "Serial murderers -- Fiction", "Detective and mystery stories"]);
      applySubjects(tx, ids.hippo!, ["Juvenile Fiction", "Animals", "Hippopotamus -- Juvenile fiction"]);
    });
    const names = (bookId: string) =>
      f.db
        .select({ name: tags.name, kind: tags.kind })
        .from(bookTags)
        .innerJoin(tags, eq(tags.id, bookTags.tagId))
        .where(eq(bookTags.bookId, bookId))
        .all()
        .filter((t) => t.kind === "genre")
        .map((t) => t.name)
        .sort();
    expect(names(ids.thriller!)).toEqual(["Horror", "Mystery & Crime", "Thriller & Suspense"]);
    expect(names(ids.hippo!)).toEqual(["Children's Books", "Fiction"]);
    const rebuild = await f.app.inject({ method: "POST", url: "/api/admin/categories/rebuild", headers: f.as("admin") });
    expect(rebuild.json()).toMatchObject({ books: 2, linked: 0 });
    expect((await f.app.inject({ method: "POST", url: "/api/admin/categories/rebuild", headers: f.as("kid") })).statusCode).toBe(403);
  });


  it("pages a category's books and 404s one that is entirely locked", async () => {
    const kid = await get(`/api/categories/${cookbooks}`, "kid");
    expect(kid.json()).toMatchObject({ total: 1, category: { name: "Cookbooks", cookbook: true } });
    expect((await get(`/api/categories/${horror}`, "kid")).statusCode).toBe(404);
    expect((await get(`/api/categories/${horror}`, "adult")).json().items[0].id).toBe(ids.thriller);
  });

  it("returns a book's categories only if the reader can see the book", async () => {
    const soup = await get(`/api/books/${ids.soup}/categories`, "adult");
    expect(soup.json()).toMatchObject({ cookbook: true, items: [{ name: "Cookbooks", kind: "section" }] });
    expect((await get(`/api/books/${ids.soup}/categories`, "kid")).statusCode).toBe(404);
    expect((await get(`/api/books/${ids.inbox}/categories`, "adult")).statusCode).toBe(404);
  });

  it("lets only an admin make categories and file books in them", async () => {
    expect(
      (await f.app.inject({ method: "POST", url: "/api/categories", headers: f.as("parent"), payload: { name: "Baking" } }))
        .statusCode,
    ).toBe(403);
    const made = await f.app.inject({
      method: "POST",
      url: "/api/categories",
      headers: f.as("admin"),
      payload: { name: "Baking", kind: "section" },
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ name: "Baking", kind: "section", cookbook: true });
    const put = await f.app.inject({
      method: "PUT",
      url: `/api/categories/${made.json().id}/books`,
      headers: f.as("admin"),
      payload: { add: [ids.hippo, ids.soup] },
    });
    expect(put.json().bookCount).toBe(2);
    expect(
      (
        await f.app.inject({
          method: "PUT",
          url: `/api/categories/${made.json().id}/books`,
          headers: f.as("kid"),
          payload: { remove: [ids.hippo] },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe("tidying categories from before curation", () => {
  it("turns old genre tags into subjects, merges near-duplicates and files books, without losing links", () => {
    // A library scanned by the old code: every subject a genre, with case and plural duplicates.
    f.db.delete(settings).where(eq(settings.key, "categories.taxonomy")).run();
    const old = f.db
      .insert(tags)
      .values([
        { name: "Fantasy", kind: "genre" },
        { name: "fantasy", kind: "genre" },
        { name: "Dragons", kind: "genre" },
        { name: "Dragon", kind: "genre" },
        { name: "History", kind: "genre" },
        { name: "Juvenile Fiction", kind: "genre" },
        { name: "Cookbooks", kind: "section" },
      ])
      .returning()
      .all();
    const id = (name: string) => old.find((t) => t.name === name)!.id;
    f.db
      .insert(bookTags)
      .values([
        { bookId: ids.thriller!, tagId: id("Fantasy") },
        { bookId: ids.thriller!, tagId: id("Dragons") },
        { bookId: ids.hippo!, tagId: id("fantasy") },
        { bookId: ids.hippo!, tagId: id("Dragon") },
        { bookId: ids.hippo!, tagId: id("Juvenile Fiction") },
        { bookId: ids.kindle!, tagId: id("History") },
        { bookId: ids.kindle!, tagId: id("Cookbooks") },
      ])
      .run();

    const report = upgradeCategories(f.db)!;
    expect(report).toMatchObject({ subjects: 6, merged: 2 });
    expect(upgradeCategories(f.db)).toBeNull();

    const byKind = (kind: "genre" | "subject" | "section") =>
      f.db.select().from(tags).where(eq(tags.kind, kind)).all().map((t) => t.name).sort();
    expect(byKind("subject")).toEqual(["Dragons", "Fantasy", "History", "Juvenile Fiction"]);
    expect(byKind("section")).toEqual(["Cookbooks"]);
    expect(byKind("genre")).toEqual(["Children's Books", "Fantasy", "History"]);

    const of = (bookId: string) =>
      f.db
        .select({ name: tags.name, kind: tags.kind })
        .from(bookTags)
        .innerJoin(tags, eq(tags.id, bookTags.tagId))
        .where(eq(bookTags.bookId, bookId))
        .all()
        .map((t) => `${t.kind}:${t.name}`)
        .sort();
    expect(of(ids.hippo!)).toEqual([
      "genre:Children's Books",
      "genre:Fantasy",
      "subject:Dragons",
      "subject:Fantasy",
      "subject:Juvenile Fiction",
    ]);
    expect(of(ids.kindle!)).toEqual(["genre:History", "section:Cookbooks", "subject:History"]);
  });
});

describe("Kindle library import", () => {
  const CSV = [
    "﻿ASIN,Title,Author,Purchase Date",
    'B00ZV9PXP2,"Mistborn: The Final Empire (Mistborn, Book 1) Kindle Edition","Sanderson, Brandon",2020-01-01',
    'B01N5AX61W,"The Happy Hippo",Kay Kid,2021-02-02',
    'B07XYZ1234,"Two Authors Book","Ann One; Bob Two",2021-03-03',
    'not-an-asin,"No Asin Book",Someone,',
    ',,,',
    ',"",Nobody,',
  ].join("\r\n");

  const importCsv = (who: "admin" | "parent" | "adult" | "kid", payload: Record<string, unknown>) =>
    f.app.inject({ method: "POST", url: "/api/admin/kindle/import", headers: f.as(who), payload });

  it("is admin-only", async () => {
    for (const who of ["parent", "adult", "kid"] as const)
      expect((await importCsv(who, { csv: CSV })).statusCode).toBe(403);
  });

  it("creates metadata-only Kindle books, links existing ones and skips repeats", async () => {
    const res = await importCsv("admin", { csv: CSV });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ rows: 4, created: 3, linked: 1, skipped: 0 });
    expect(body.errors).toEqual(expect.arrayContaining([expect.stringMatching(/Line 5: .*isn't an ASIN/), expect.stringMatching(/Line 7: no title/)]));

    const mist = f.db.select().from(books).where(eq(books.kindleAsin, "B00ZV9PXP2")).get()!;
    expect(mist).toMatchObject({ title: "Mistborn: The Final Empire (Mistborn, Book 1)", kindleOnly: true, approved: true, rating: null });
    const names = f.db
      .select({ name: authors.name })
      .from(bookAuthors)
      .innerJoin(authors, eq(authors.id, bookAuthors.authorId))
      .where(eq(bookAuthors.bookId, mist.id))
      .all();
    expect(names).toEqual([{ name: "Brandon Sanderson" }]);

    // The Happy Hippo was already a file book: it gains the ASIN instead of a duplicate.
    const hippo = f.db.select().from(books).where(eq(books.id, ids.hippo!)).get()!;
    expect(hippo).toMatchObject({ kindleAsin: "B01N5AX61W", kindleOnly: false });

    const two = f.db.select().from(books).where(eq(books.kindleAsin, "B07XYZ1234")).get()!;
    expect(
      f.db.select().from(bookAuthors).where(eq(bookAuthors.bookId, two.id)).all(),
    ).toHaveLength(2);

    const again = (await importCsv("admin", { csv: CSV })).json();
    expect(again).toMatchObject({ created: 0, linked: 0, skipped: 4 });
  });

  it("leaves unrated imports adult-only and shows them as Kindle books", async () => {
    await importCsv("admin", { csv: CSV });
    const kid = (await get("/api/books?q=Mistborn", "kid")).json();
    expect(kid.total).toBe(0);
    const adult = (await get("/api/books?q=Mistborn", "adult")).json();
    expect(adult.items[0]).toMatchObject({ kindleOnly: true });
    const detail = (await get(`/api/books/${adult.items[0].id}`, "adult")).json();
    expect(detail.kindleAsin).toBe("B00ZV9PXP2");
  });

  it("applies a rating to new entries and supports a dry run", async () => {
    const dry = (await importCsv("admin", { csv: CSV, dryRun: true })).json();
    expect(dry).toMatchObject({ dryRun: true, created: 3, linked: 1 });
    expect(f.db.select().from(books).where(eq(books.kindleOnly, true)).all()).toHaveLength(1); // only the seed

    await importCsv("admin", { csv: CSV, rating: "kids" });
    const kid = (await get("/api/books?q=Mistborn", "kid")).json();
    expect(kid.total).toBe(1);
  });

  it("rejects a file with no title column", async () => {
    const res = (await importCsv("admin", { csv: "foo,bar\n1,2" })).json();
    expect(res).toMatchObject({ created: 0, rows: 0 });
    expect(res.errors[0]).toMatch(/Title/);
  });
});

describe("Hardcover trending", () => {
  it("keeps Hardcover's order and matches by Hardcover id", async () => {
    await f.close();
    const bodies: string[] = [];
    const hcFetch = async (url: string, init?: RequestInit) => {
      if (!url.includes("hardcover")) return Response.json({ works: [] });
      const body = String(init?.body);
      bodies.push(body);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer hc-token");
      if (body.includes("books_trending")) return Response.json({ data: { books_trending: { ids: [22, 11] } } });
      return Response.json({
        data: {
          books: [
            { id: 11, title: "Grown-up Thriller", slug: "thriller", cached_contributors: [{ author: { name: "Ann Adult" } }] },
            { id: 22, title: "Fresh Release", slug: "fresh", release_year: 2026, cached_image: { url: "https://img/x.jpg" } },
          ],
        },
      });
    };
    f = await family({ discover: { fetchImpl: (u, i) => hcFetch(String(u), i), now: () => NOW } }, { HARDCOVER_API_TOKEN: "hc-token" });
    f.book("Grown-up Thriller", "adult", { hardcoverId: "11", sortTitle: "zzz" });
    const list = (await get("/api/discover", "adult")).json().lists.find((l: { id: string }) => l.id === "hardcover-trending");
    expect(list.items.map((i: { title: string; status: string }) => [i.title, i.status])).toEqual([
      ["Fresh Release", "request"],
      ["Grown-up Thriller", "library"],
    ]);
    expect(list.items[0]).toMatchObject({ coverUrl: "https://img/x.jpg", url: "https://hardcover.app/books/fresh", year: 2026 });
    expect(JSON.parse(bodies[0]!).variables).toMatchObject({ from: "2026-10-15", to: "2026-11-14" });
  });
});

describe("Kindle CSV parsing", () => {
  it("handles quotes, semicolons and Amazon title decorations", async () => {
    const { parseCsv, readKindleCsv, cleanTitle, splitAuthors } = await import("../src/discover/kindle.js");
    expect(parseCsv('a;b\n"x;""y""";z')).toEqual([["a", "b"], ['x;"y"', "z"]]);
    expect(cleanTitle("Dune (Kindle Edition)")).toBe("Dune");
    expect(cleanTitle("Project Hail Mary eBook : Weir, Andy: Amazon.com")).toBe("Project Hail Mary");
    expect(splitAuthors("Pratchett, Terry & Gaiman, Neil")).toEqual(["Terry Pratchett", "Neil Gaiman"]);
    expect(splitAuthors("A One, B Two, C Three")).toEqual(["A One", "B Two", "C Three"]);
    const { rows } = readKindleCsv("Product Name\tASIN\tAuthors\nDune\tB00B7NPRY8\tFrank Herbert\n");
    expect(rows).toEqual([{ line: 2, asin: "B00B7NPRY8", title: "Dune", authors: ["Frank Herbert"], isbn13: null }]);
  });
});
