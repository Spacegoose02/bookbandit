/** The richer Discover page: personal rows, genres, prizes, English covers, de-duplication and the lock. */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authors, bookAuthors, bookSeries, bookTags, readingProgress, series, tags } from "../src/db/schema.js";
import { family, type Family } from "./helpers.js";

const NOW = Date.UTC(2026, 10, 14);
let f: Family;
let calls: string[];

afterEach(async () => {
  await f.close();
});

const work = (id: string, title: string, author: string, extra: Record<string, unknown> = {}) => ({
  key: `/works/${id}`,
  title,
  author_name: [author],
  first_publish_year: 2025,
  cover_i: Number(id.replace(/\D/g, "")),
  language: ["eng"],
  ...extra,
});

/** Open Library stand-in: answers by what the query asks for. */
function olFetch(url: string, init?: RequestInit, hardcover?: (body: string) => unknown): Promise<Response> {
  calls.push(url);
  if (url.includes("hardcover")) {
    const body = String(init?.body);
    if (hardcover) return Promise.resolve(Response.json(hardcover(body)));
    return Promise.resolve(Response.json({ data: { books_trending: { ids: [] } } }));
  }
  if (url.includes("/trending/weekly"))
    return Promise.resolve(
      Response.json({
        works: [
          // Open Library's own pick of cover for this one is a French edition (cover 900).
          work("OL900W", "How to Make Friends", "Dale Example", { cover_i: 900, language: ["fre", "eng"] }),
          work("OL901W", "Trending Only", "Tia Trend"),
          work("OL902W", "Pas en anglais", "Jean Français", { language: ["fre"] }),
        ],
      }),
    );
  const u = new URL(url);
  const q = u.searchParams.get("q") ?? "";
  if (u.pathname === "/search.json" && q.startsWith("key:"))
    return Promise.resolve(
      Response.json({
        docs: [
          {
            ...work("OL900W", "How to Make Friends", "Dale Example", { cover_i: 900, language: ["fre", "eng"] }),
            editions: { docs: [{ key: "/books/OL1M", title: "How to Make Friends", cover_i: 901, language: ["eng"], isbn: ["9780000000019"] }] },
          },
        ],
      }),
    );
  if (q.includes(`author:"Ann Adult"`))
    return Promise.resolve(Response.json({ docs: [work("OL10W", "Grown-up Thriller", "Ann Adult"), work("OL11W", "Ann's Next Big One", "Ann Adult")] }));
  if (q.includes(`subject:("Serial murderers")`))
    return Promise.resolve(Response.json({ docs: [work("OL40W", "Same Ann Again", "Ann Adult"), work("OL41W", "Killer Instinct", "Kim Similar")] }));
  if (q.includes("subject:(thriller"))
    // "Trending Only" is also in the trending row above: it should only show once.
    return Promise.resolve(Response.json({ docs: [work("OL20W", "Edge of Night", "Sam Suspense"), work("OL901W", "Trending Only", "Tia Trend"), work("OL21W", "Cold Wire", "Sam Suspense"), work("OL22W", "Last Call", "Lee Tense")] }));
  if (q.includes("subject:"))
    return Promise.resolve(Response.json({ docs: [work("OL30W", `Genre pick ${calls.length}`, "Gina Genre"), work("OL31W", `Genre pick b${calls.length}`, "Gina Genre"), work("OL32W", `Genre pick c${calls.length}`, "Gina Genre")] }));
  return Promise.resolve(Response.json({ docs: [] }));
}

function addAuthor(bookId: string, name: string) {
  f.db.insert(authors).values({ name, sortName: name }).onConflictDoNothing().run();
  const a = f.db.select().from(authors).where(eq(authors.name, name)).get()!;
  f.db.insert(bookAuthors).values({ bookId, authorId: a.id }).run();
}
function tag(bookId: string, name: string) {
  f.db.insert(tags).values({ name, kind: "genre" }).onConflictDoNothing().run();
  const t = f.db.select().from(tags).where(eq(tags.name, name)).get()!;
  f.db.insert(bookTags).values({ bookId, tagId: t.id }).run();
}
function read(user: string, bookId: string, percent = 1) {
  f.db
    .insert(readingProgress)
    .values({ userId: user, bookId, locator: { kind: "epub", cfi: "x", percent }, percent, finished: percent >= 1, clientUpdatedAt: NOW, serverUpdatedAt: NOW })
    .run();
}

interface Item {
  key: string;
  title: string;
  authors: string[];
  bookId: string | null;
  status: string;
  coverUrl: string | null;
  note?: string;
  requestable: boolean;
}
interface List {
  id: string;
  name: string;
  group: string;
  items: Item[];
}

async function discover(who: "adult" | "kid"): Promise<{ lists: List[]; requests: boolean }> {
  const res = await f.app.inject({ method: "GET", url: "/api/discover", headers: f.as(who) });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("Discover rows", () => {
  it("builds personal rows from what the reader has read, de-duplicated across the page", async () => {
    calls = [];
    f = await family({ discover: { fetchImpl: (u, i) => olFetch(String(u), i), now: () => NOW } });
    const one = f.book("Grown-up Thriller", "adult");
    const two = f.book("Dark Nights Two", "adult");
    const other = f.book("Ann's Other Book", "adult");
    const [s] = f.db.insert(series).values({ name: "Dark Nights" }).returning().all();
    f.db.insert(bookSeries).values([
      { seriesId: s!.id, bookId: one, position: 1 },
      { seriesId: s!.id, bookId: two, position: 2 },
    ]).run();
    for (const b of [one, two, other]) addAuthor(b, "Ann Adult");
    tag(one, "Thriller & Suspense");
    f.db.insert(tags).values({ name: "Serial murderers", kind: "subject" }).run();
    const subject = f.db.select().from(tags).where(eq(tags.name, "Serial murderers")).get()!;
    f.db.insert(bookTags).values({ bookId: one, tagId: subject.id }).run();
    read(f.ids.adult, one);

    const { lists } = await discover("adult");
    const byId = Object.fromEntries(lists.map((l) => [l.id, l]));

    // Next in your series: book 2 from the library.
    expect(byId["series-next"]!.items.map((i) => [i.bookId, i.note])).toEqual([[two, "Book 2 of Dark Nights"]]);
    // Because you read: Barnaby's "more like this" from the library (book 2 is already above).
    const because = byId[`because-${one}`]!;
    expect(because.name).toBe("Because you read Grown-up Thriller");
    expect(because.items[0]).toMatchObject({ bookId: other, note: "Also by Ann Adult" });
    // ...then similar books elsewhere, by other authors (the author row covers Ann).
    expect(because.items.slice(1).map((i) => i.title)).toEqual(["Killer Instinct"]);
    expect(calls.some((c) => new URL(c).searchParams.get("q")?.startsWith(`subject:("Serial murderers")`))).toBe(true);
    // More by the author: the one the library doesn't have, never the one already read.
    const more = byId["author-ann-adult"]!;
    expect(more.items.map((i) => [i.title, i.status])).toEqual([["Ann's Next Big One", "request"]]);

    // Nothing the reader has already opened is suggested again (except the family row).
    const suggested = lists.filter((l) => l.id !== "family").flatMap((l) => l.items);
    expect(suggested.some((i) => i.bookId === one)).toBe(false);
    // No book shows twice on the page.
    const keys = lists.flatMap((l) => l.items.map((i) => i.bookId ?? `${i.title}|${i.authors[0]}`));
    expect(new Set(keys).size).toBe(keys.length);
    expect(byId["genre-thriller-suspense"]!.items.map((i) => i.title)).toEqual(["Edge of Night", "Cold Wire", "Last Call"]);

    // The reader's favourite genre comes first among the genre rows.
    expect(lists.filter((l) => l.group === "genres")[0]!.id).toBe("genre-thriller-suspense");
    // English covers, and nothing without an English edition.
    const trending = byId["openlibrary-weekly"]!;
    expect(trending.items.find((i) => i.title === "How to Make Friends")!.coverUrl).toContain("/901-M.jpg");
    expect(trending.items.some((i) => i.title === "Pas en anglais")).toBe(false);
    // Searches ask for English editions.
    const search = calls.filter((c) => c.includes("/search.json") && !c.includes("title="));
    expect(search.every((c) => new URL(c).searchParams.get("lang") === "en")).toBe(true);
    expect(search.filter((c) => !new URL(c).searchParams.get("q")!.startsWith("key:")).every((c) => new URL(c).searchParams.get("q")!.includes("language:eng"))).toBe(true);
    // Prize winners for grown-ups, from the hand-picked list.
    expect(byId.awards!.items[0]).toMatchObject({ title: "Flesh", note: "Booker Prize 2025", requestable: true });
  });

  it("keeps a kid's rows on their side of the content lock", async () => {
    calls = [];
    f = await family({ discover: { fetchImpl: (u, i) => olFetch(String(u), i), now: () => NOW } });
    const k1 = f.book("Hippo Starts", "kids");
    const k2 = f.book("Hippo Goes On", "kids");
    const grown = f.book("Hippo Grows Up", "adult");
    const pony = f.book("Pony Days", "kids");
    const [s] = f.db.insert(series).values({ name: "Hippo Tales" }).returning().all();
    f.db.insert(bookSeries).values([
      { seriesId: s!.id, bookId: k1, position: 1 },
      { seriesId: s!.id, bookId: grown, position: 2 },
      { seriesId: s!.id, bookId: k2, position: 3 },
    ]).run();
    for (const b of [k1, k2, grown]) addAuthor(b, "Kay Kid");
    const joke = f.book("Silly Jokes", "kids");
    for (const b of [k1, grown]) tag(b, "Children's Books");
    for (const b of [pony, joke, grown]) tag(b, "Humor");
    read(f.ids.kid, k1, 0.5);

    const body = await discover("kid");
    expect(body.requests).toBe(false);
    const json = JSON.stringify(body);
    expect(json).not.toContain(grown);
    expect(json).not.toContain("Hippo Grows Up");
    const byId = Object.fromEntries(body.lists.map((l) => [l.id, l]));
    expect(byId["series-next"]!.items.map((i) => i.bookId)).toEqual([k2]);
    // Genre rows come from the library for kids, without the locked book.
    expect(byId["genre-humor"]!.items.map((i) => i.bookId).sort()).toEqual([pony, joke].sort());
    // Grown-up prizes are left out; kids' prizes only up to the kid's rating (picture books here).
    expect(byId.awards).toBeUndefined();
    const prizes = byId["awards-kids"]!.items;
    expect(prizes.length).toBeGreaterThan(3);
    expect(prizes.every((i) => i.note?.startsWith("Caldecott Medal") && i.requestable)).toBe(true);
    // Every other outside book is unrated, so only library matches get through.
    for (const l of body.lists.filter((x) => x.id !== "awards-kids")) for (const i of l.items) expect(i.bookId).not.toBeNull();
  });

  it("finds the next books in a series the library is missing, through Hardcover", async () => {
    calls = [];
    const hc = (body: string) => {
      if (body.includes("books_trending")) return { data: { books_trending: { ids: [] } } };
      if (body.includes("book_series"))
        return {
          data: {
            series: [
              {
                book_series: [
                  { position: 1, book: { id: 1, title: "Dark Nights One", slug: "dn1" } },
                  { position: 1.5, book: { id: 15, title: "A Dark Novella", slug: "dn15" } },
                  { position: 2, book: { id: 2, title: "Dark Nights Two", slug: "dn2" } },
                  { position: 3, book: { id: 3, title: "Dark Nights Three", slug: "dn3", cached_image: { url: "https://img/3.jpg" } } },
                ],
              },
            ],
          },
        };
      return { data: {} };
    };
    f = await family({ discover: { fetchImpl: (u, i) => olFetch(String(u), i, hc), now: () => NOW } }, { HARDCOVER_API_TOKEN: "tok" });
    const one = f.book("Dark Nights One", "adult");
    const two = f.book("Dark Nights Two", "adult");
    const [s] = f.db.insert(series).values({ name: "Dark Nights" }).returning().all();
    f.db.insert(bookSeries).values([
      { seriesId: s!.id, bookId: one, position: 1 },
      { seriesId: s!.id, bookId: two, position: 2 },
    ]).run();
    read(f.ids.adult, one);
    const row = (await discover("adult")).lists.find((l) => l.id === "series-next")!;
    expect(row.items.map((i) => [i.title, i.status, i.note])).toEqual([
      ["Dark Nights Two", "library", "Book 2 of Dark Nights"],
      ["Dark Nights Three", "request", "Book 3 of Dark Nights"],
    ]);
  });
});
