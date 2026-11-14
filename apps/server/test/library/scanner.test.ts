import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../../src/db/client.js";
import { authors, bookAuthors, bookFiles, books, bookSeries, series } from "../../src/db/schema.js";
import { scanLibrary, type ScanOptions } from "../../src/library/scanner.js";
import { fakeFetch, makeCbz, makeEpub, makePdf, PNG, tempDir } from "./fixtures.js";

let db: Db;
let close: () => void;
let booksDir: string;
let configDir: string;

beforeEach(async () => {
  ({ db, close } = openDb(":memory:"));
  booksDir = await tempDir("bb-books-");
  configDir = await tempDir("bb-config-");
});
afterEach(() => close());

const scan = (extra: Partial<ScanOptions> = {}) => scanLibrary({ db, booksDir, configDir, online: false, ...extra });
const bookByTitle = (title: string) => db.select().from(books).where(eq(books.title, title)).get();

describe("library scan", () => {
  it("imports files into the inbox with authors, series and covers", async () => {
    await makeEpub(join(booksDir, "Roald Dahl/Matilda.epub"), { title: "Matilda", authors: ["Roald Dahl"], series: "Dahl", seriesIndex: 2, cover: true });
    await makeCbz(join(booksDir, "comics/Dog Man 1.cbz"), { Series: "Dog Man", Number: "1", Writer: "Dav Pilkey" });
    await makePdf(join(booksDir, "Irma Rombauer - Joy of Cooking.pdf"), {});

    const report = await scan();
    expect(report).toMatchObject({ filesSeen: 3, added: 3, errors: [] });

    const matilda = bookByTitle("Matilda")!;
    expect(matilda.approved).toBe(false); // inbox
    expect(matilda.coverPath).toBe(`covers/${matilda.id}.png`);
    await expect(stat(join(configDir, matilda.coverPath!))).resolves.toBeDefined();
    const names = db.select({ name: authors.name }).from(bookAuthors).innerJoin(authors, eq(authors.id, bookAuthors.authorId)).where(eq(bookAuthors.bookId, matilda.id)).all();
    expect(names).toEqual([{ name: "Roald Dahl" }]);
    const s = db.select().from(bookSeries).innerJoin(series, eq(series.id, bookSeries.seriesId)).where(eq(bookSeries.bookId, matilda.id)).get();
    expect(s).toMatchObject({ series: { name: "Dahl" }, book_series: { position: 2 } });

    expect(bookByTitle("Dog Man #1")).toBeDefined();
    expect(bookByTitle("Joy of Cooking")).toBeDefined();
  });

  it("skips unchanged files, follows moves and drops deleted files without deleting the book", async () => {
    await makeEpub(join(booksDir, "a/Book.epub"), { title: "Book", authors: ["A"] });
    await scan();
    const again = await scan();
    expect(again).toMatchObject({ unchanged: 1, added: 0 });

    await mkdir(join(booksDir, "b"));
    await rename(join(booksDir, "a/Book.epub"), join(booksDir, "b/Book.epub"));
    const moved = await scan();
    expect(moved).toMatchObject({ moved: 1, added: 0, removed: 0 });
    expect(db.select().from(bookFiles).all().map((f) => f.relPath)).toEqual(["b/Book.epub"]);

    await rm(join(booksDir, "b/Book.epub"));
    const gone = await scan();
    expect(gone.removed).toBe(1);
    const book = bookByTitle("Book")!;
    expect(gone.missingBookIds).toEqual([book.id]);
  });

  it("attaches exact copies and other formats to the same book", async () => {
    await makeEpub(join(booksDir, "Matilda.epub"), { title: "Matilda", authors: ["Roald Dahl"], isbn: "0142410373" });
    await scan();
    await cp(join(booksDir, "Matilda.epub"), join(booksDir, "copy/Matilda.epub"), { recursive: true });
    await makePdf(join(booksDir, "Roald Dahl - Matilda.pdf"), { title: "Matilda", author: "Roald Dahl" });

    const report = await scan();
    expect(report.added).toBe(0);
    expect(report.attached).toBe(2);
    expect(report.duplicates).toEqual([{ relPath: "copy/Matilda.epub", sameAs: "Matilda.epub" }]);
    expect(db.select().from(books).all()).toHaveLength(1);
    expect(db.select().from(bookFiles).all()).toHaveLength(3);
  });

  it("rates books from rating folders and raises approved books moved into /adult", async () => {
    await makeEpub(join(booksDir, "kids/Picture.epub"), { title: "Picture", authors: ["P"] });
    await makeEpub(join(booksDir, "adult/Grown Up.epub"), { title: "Grown Up", authors: ["G"], salt: "x1" });
    await makeEpub(join(booksDir, "explicit/Spicy.epub"), { title: "Spicy", authors: ["S"], salt: "x2" });
    await makeEpub(join(booksDir, "kids/Sneaky.epub"), { title: "Sneaky", authors: ["S"], subjects: ["Erotica"], salt: "x3" });
    await scan();
    expect(bookByTitle("Picture")).toMatchObject({ rating: "kids", ratingSource: "folder" });
    expect(bookByTitle("Grown Up")).toMatchObject({ rating: "adult", ratingSource: "folder" });
    expect(bookByTitle("Spicy")).toMatchObject({ rating: "explicit" });
    expect(bookByTitle("Sneaky")).toMatchObject({ rating: "explicit", ratingSource: "keywords" });

    db.update(books).set({ approved: true }).run();
    await mkdir(join(booksDir, "explicit/more"), { recursive: true });
    await rename(join(booksDir, "kids/Picture.epub"), join(booksDir, "explicit/more/Picture.epub"));
    await scan();
    expect(bookByTitle("Picture")).toMatchObject({ rating: "explicit", ratingSource: "folder" });
  });

  it("looks new books up online: Google mature flag, genres, provider ids and cover", async () => {
    await makeEpub(join(booksDir, "Some Author - Night Book.epub"), { title: "Night Book", authors: ["Some Author"] });
    await makeEpub(join(booksDir, "Kid Writer - Puppy Day.epub"), { title: "Puppy Day", authors: ["Kid Writer"], salt: "p1" });
    const { fetch, calls } = fakeFetch([
      [/googleapis.*Night/, { items: [{ id: "g1", volumeInfo: { title: "Night Book", authors: ["Some Author"], maturityRating: "MATURE", categories: ["Fiction / Thrillers"], description: "<b>Dark</b>", imageLinks: { thumbnail: "http://img.example/night.jpg" } } }] }],
      [/googleapis.*Puppy/, { items: [{ id: "g2", volumeInfo: { title: "A Totally Different Book", authors: ["Someone Else"], maturityRating: "MATURE" } }] }],
      [/openlibrary.org\/search.json.*Puppy/, { docs: [{ key: "/works/OL1W", title: "Puppy Day", author_name: ["Kid Writer"], subject: ["Picture books", "Dogs"], first_publish_year: 2001 }] }],
      ["openlibrary.org/works/OL1W.json", { description: { value: "A puppy has a day." } }],
      ["img.example/night.jpg", Buffer.concat([PNG, Buffer.alloc(2048)])],
    ]);
    const report = await scan({ online: { fetch } });
    expect(report.added).toBe(2);

    const night = bookByTitle("Night Book")!;
    expect(night).toMatchObject({ rating: "adult", ratingSource: "metadata", googleBooksId: "g1", description: "Dark" });
    expect(night.coverPath).toBe(`covers/${night.id}.jpg`);

    // The Google hit for Puppy Day is a different book, so its MATURE flag must be ignored.
    const puppy = bookByTitle("Puppy Day")!;
    expect(puppy).toMatchObject({ rating: "kids", ratingSource: "keywords", openLibraryId: "OL1W", googleBooksId: null, description: "A puppy has a day.", publishedYear: 2019 });
    expect(calls.some((c) => c.includes("hardcover"))).toBe(false); // no token, no Hardcover calls
  });

  it("keeps importing when a file is corrupt", async () => {
    await mkdir(join(booksDir, "x"));
    await (await import("node:fs/promises")).writeFile(join(booksDir, "x/Broken - Thing.epub"), "not a zip");
    const report = await scan();
    expect(report.added).toBe(1);
    expect(report.errors[0]?.error).toMatch(/^metadata:/);
    expect(bookByTitle("Thing")).toBeDefined();
  });
});
