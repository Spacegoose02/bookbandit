import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { books, bookSeries, bookTags, series, tags } from "../src/db/schema.js";
import { enrichBook } from "../src/library/enrich.js";
import { applySubjects, rebuildCategories } from "../src/discover/category-store.js";
import { family, type Family } from "./helpers.js";

let f: Family;
beforeEach(async () => {
  f = await family({}, { METADATA_ONLINE: "false" });
});
afterEach(async () => {
  await f.close();
});

const patch = (id: string, body: unknown, who: "admin" | "parent" | "kid" = "admin") =>
  f.app.inject({ method: "PATCH", url: `/api/admin/books/${id}`, headers: f.as(who), payload: body as object });

const genres = (bookId: string) =>
  f.db
    .select({ name: tags.name })
    .from(bookTags)
    .innerJoin(tags, eq(tags.id, bookTags.tagId))
    .where(and(eq(bookTags.bookId, bookId), eq(tags.kind, "genre")))
    .all()
    .map((t) => t.name)
    .sort();

/** One provider (Google) that knows every book as a nonfiction title with a description. */
const google = async (input: string) => {
  const url = new URL(input);
  if (url.host !== "www.googleapis.com") return new Response("{}", { status: 404 });
  return new Response(
    JSON.stringify({
      items: [
        {
          id: "g1",
          volumeInfo: {
            title: "Dune",
            authors: ["Someone Else"],
            description: "From the provider",
            publisher: "Provider Press",
            categories: ["Self-Help / Personal Growth"],
          },
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
};

describe("book editor", () => {
  it("edits series, categories and titles, and locks what it changed", async () => {
    const id = f.book("dune", "teen");
    applySubjects(f.db, id, ["Nonfiction", "Ireland"]);
    expect(genres(id)).toEqual(["Nonfiction"]);

    const res = await patch(id, {
      title: "Dune",
      originalTitle: "Dune",
      series: { name: "Dune Chronicles", position: 1 },
      categories: ["Science Fiction", "Fiction"],
    });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({ title: "Dune", sortTitle: "dune", originalTitle: "Dune" });
    expect(b.lockedFields.sort()).toEqual(["categories", "originalTitle", "series", "title"]);
    expect(b.series).toMatchObject([{ name: "Dune Chronicles", position: 1 }]);
    expect(genres(id)).toEqual(["Fiction", "Science Fiction"]);

    // Taking it out of its series, and an explicit lock list replaces the old one.
    const again = (await patch(id, { series: null, locks: ["title"] })).json();
    expect(again.series).toEqual([]);
    expect(again.lockedFields).toEqual(["title"]);
    expect(f.db.select().from(bookSeries).where(eq(bookSeries.bookId, id)).all()).toEqual([]);
    expect(f.db.select().from(series).all().map((s) => s.name)).toEqual(["Dune Chronicles"]);
  });

  it("is admin-only", async () => {
    const id = f.book("Dune", "teen");
    for (const who of ["parent", "kid"] as const) {
      expect((await patch(id, { categories: ["Fiction"] }, who)).statusCode).toBe(403);
      expect((await f.app.inject({ method: "GET", url: "/api/admin/category-names", headers: f.as(who) })).statusCode).toBe(403);
    }
    const names = (await f.app.inject({ method: "GET", url: "/api/admin/category-names", headers: f.as("admin") })).json().names;
    expect(names).toEqual(expect.arrayContaining(["Fiction", "Nonfiction", "Science Fiction"]));
  });

  it("keeps locked categories when new subjects arrive or Nonfiction guesses are re-filed", async () => {
    const id = f.book("Dune", "teen");
    await patch(id, { categories: ["Nonfiction"] });
    applySubjects(f.db, id, ["Fiction", "Romance"]);
    expect(genres(id)).toEqual(["Nonfiction"]);
    expect(rebuildCategories(f.db)).toMatchObject({ refiled: 0 });
    expect(genres(id)).toEqual(["Nonfiction"]);
  });

  it("metadata refresh leaves locked fields alone, even empty ones, and fills the rest", async () => {
    const id = f.book("Dune", "teen");
    await patch(id, { description: null, authors: [] });
    await enrichBook({ db: f.db, configDir: "/tmp/bb-none", bookId: id, lookup: { fetch: google } });
    const b = f.db.select().from(books).where(eq(books.id, id)).get()!;
    expect(b.description).toBeNull();
    expect(b.publisher).toBe("Provider Press");
    // Categories weren't locked here, so the auto-categorizer still files it.
    expect(genres(id)).toEqual(["Self-Help"]);

    await patch(id, { publisher: "Ace" });
    const c = f.db.select().from(books).where(eq(books.id, id)).get()!;
    expect(c.lockedFields.sort()).toEqual(["authors", "description", "publisher"]);
  });
});
