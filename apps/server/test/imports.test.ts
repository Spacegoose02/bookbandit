import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookFiles, books, bookSeries, collectionBooks, collections, readingProgress, series } from "../src/db/schema.js";
import { bookIdentifiers, readingHistory } from "../src/imports/schema.js";
import { setBookAuthors } from "../src/library/store.js";
import { readHistoryCsv } from "../src/imports/goodreads.js";
import { readPlayLibrary, volumeIdFrom } from "../src/imports/google-play.js";
import { FileIndex, parseDate } from "../src/imports/common.js";
import { lookupOnline } from "../src/metadata/lookup.js";
import { sortTitle } from "../src/metadata/text.js";
import { family, type Family } from "./helpers.js";

let f: Family;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bb-import-"));
});
afterEach(async () => {
  await f?.close();
  rmSync(dir, { recursive: true, force: true });
});

type Who = "admin" | "parent" | "adult" | "kid";

async function startImport(body: Record<string, unknown>, who: Who = "admin") {
  const res = await f.app.inject({ method: "POST", url: "/api/admin/imports", headers: f.as(who), payload: body });
  return res;
}

async function runImport(body: Record<string, unknown>) {
  const res = await startImport(body);
  expect(res.statusCode, res.body).toBe(202);
  await f.app.jobs.drain();
  const job = (await f.app.inject({ url: `/api/admin/imports/${res.json().jobId}`, headers: f.as("admin") })).json();
  return job;
}

async function upload(content: string | Buffer, name = "file") {
  const res = await f.app.inject({
    method: "POST",
    url: `/api/admin/imports/uploads?name=${name}`,
    headers: { ...f.as("admin"), "content-type": "application/octet-stream" },
    payload: typeof content === "string" ? Buffer.from(content) : content,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().uploadId as string;
}

function fileBook(title: string, relPath: string, authors: string[], extra: Partial<typeof books.$inferInsert> = {}) {
  const id = f.book(title, "teen", { sortTitle: sortTitle(title), ...extra });
  setBookAuthors(f.db, id, authors);
  f.db.insert(bookFiles).values({ bookId: id, relPath, format: relPath.endsWith(".pdf") ? "pdf" : "epub", sizeBytes: 1000 }).run();
  return id;
}

/** A small Calibre library: metadata.db plus a cover. */
function makeCalibre(root: string) {
  mkdirSync(join(root, "Brandon Sanderson", "Mistborn (1)"), { recursive: true });
  writeFileSync(join(root, "Brandon Sanderson", "Mistborn (1)", "cover.jpg"), Buffer.alloc(2048, 1));
  const db = new Database(join(root, "metadata.db"));
  db.exec(`
    create table library_id (id integer primary key, uuid text);
    insert into library_id (uuid) values ('lib-uuid');
    create table books (id integer primary key, title text, sort text, timestamp text, pubdate text, series_index real, author_sort text, isbn text, path text, uuid text, has_cover integer, last_modified text);
    create table authors (id integer primary key, name text, sort text, link text);
    create table books_authors_link (id integer primary key, book integer, author integer);
    create table series (id integer primary key, name text, sort text);
    create table books_series_link (id integer primary key, book integer, series integer);
    create table tags (id integer primary key, name text);
    create table books_tags_link (id integer primary key, book integer, tag integer);
    create table identifiers (id integer primary key, book integer, type text, val text);
    create table publishers (id integer primary key, name text, sort text);
    create table books_publishers_link (id integer primary key, book integer, publisher integer);
    create table languages (id integer primary key, lang_code text);
    create table books_languages_link (id integer primary key, book integer, lang_code integer, item_order integer);
    create table comments (id integer primary key, book integer, text text);
    create table data (id integer primary key, book integer, format text, uncompressed_size integer, name text);

    insert into books values (1, 'Mistborn: The Final Empire', 'Mistborn', '', '2006-07-17 00:00:00+00:00', 1, '', '', 'Brandon Sanderson/Mistborn (1)', 'uuid-1', 1, '');
    insert into books values (2, 'The Hobbit', 'Hobbit, The', '', '0101-01-01 00:00:00+00:00', 1, '', '', 'J. R. R. Tolkien/The Hobbit (2)', 'uuid-2', 0, '');
    insert into books values (3, 'Not Scanned', 'Not Scanned', '', '', 1, '', '', 'Someone/Not Scanned (3)', 'uuid-3', 0, '');
    insert into authors values (1, 'Brandon Sanderson', 'Sanderson, Brandon', ''), (2, 'J. R. R. Tolkien', 'Tolkien, J. R. R.', ''), (3, 'Someone', 'Someone', '');
    insert into books_authors_link (book, author) values (1, 1), (2, 2), (3, 3);
    insert into series values (1, 'Mistborn', 'Mistborn');
    insert into books_series_link (book, series) values (1, 1);
    insert into tags values (1, 'Fantasy'), (2, 'Epic');
    insert into books_tags_link (book, tag) values (1, 1), (1, 2), (2, 1);
    insert into identifiers (book, type, val) values (1, 'isbn', '9780765311788'), (1, 'goodreads', '68428'), (2, 'goodreads', '5907');
    insert into publishers values (1, 'Tor', 'Tor');
    insert into books_publishers_link (book, publisher) values (1, 1);
    insert into languages values (1, 'eng');
    insert into books_languages_link (book, lang_code, item_order) values (1, 1, 0);
    insert into comments (book, text) values (1, '<p>The <b>Lord Ruler</b> reigns.</p>');
    insert into data (book, format, uncompressed_size, name) values
      (1, 'EPUB', 1000, 'Mistborn_ The Final Empire - Brandon Sanderson'),
      (2, 'EPUB', 1000, 'The Hobbit - J. R. R. Tolkien'),
      (3, 'EPUB', 1000, 'Not Scanned - Someone');
  `);
  db.close();
}

function makeCalibreWeb(path: string) {
  const db = new Database(path);
  db.exec(`
    create table user (id integer primary key, name text, email text, role integer, password text);
    insert into user values (1, 'admin', 'admin@example.com', 1, ''), (2, 'Guest', '', 0, ''), (3, 'emma', 'emma@example.com', 0, ''), (4, 'stranger', 'nobody@example.com', 0, '');
    create table book_read_link (id integer primary key, book_id integer, user_id integer, read_status integer, last_modified text, last_time_started_reading text, times_started_reading integer);
    insert into book_read_link (book_id, user_id, read_status, last_modified, last_time_started_reading, times_started_reading) values
      (1, 1, 1, '2024-03-01 10:00:00.000000', '2024-02-01 10:00:00.000000', 2),
      (2, 3, 2, '2024-04-01 10:00:00', null, 1),
      (1, 4, 1, '2024-04-01 10:00:00', null, 1);
    create table shelf (id integer primary key, uuid text, name text, is_public integer, user_id integer, kobo_sync integer, created text, last_modified text);
    insert into shelf (id, name, is_public, user_id) values (1, 'Bedtime', 0, 3), (2, 'Family favourites', 1, 1);
    create table book_shelf_link (id integer primary key, book_id integer, "order" integer, shelf integer, date_added text);
    insert into book_shelf_link (book_id, "order", shelf) values (2, 1, 1), (1, 1, 2), (2, 2, 2), (99, 3, 2);
    create table kobo_reading_state (id integer primary key, user_id integer, book_id integer, last_modified text, priority_timestamp text);
    create table kobo_bookmark (id integer primary key, kobo_reading_state_id integer, last_modified text, location_source text, location_type text, location_value text, progress_percent real, content_source_progress_percent real);
    insert into kobo_reading_state values (1, 3, 2, '2024-04-02 10:00:00', '2024-04-02 10:00:00');
    insert into kobo_bookmark (kobo_reading_state_id, last_modified, progress_percent) values (1, '2024-04-02 10:00:00', 40);
  `);
  db.close();
}

describe("imports: access", () => {
  it("is admin-only", async () => {
    f = await family({ jobsAutostart: false }, { CONFIG_DIR: dir });
    for (const who of ["parent", "adult", "kid"] as const) {
      expect((await startImport({ source: "google-play", file: { uploadId: crypto.randomUUID() } }, who)).statusCode).toBe(403);
      expect((await f.app.inject({ url: "/api/admin/imports", headers: f.as(who) })).statusCode).toBe(403);
      const up = await f.app.inject({
        method: "POST",
        url: "/api/admin/imports/uploads",
        headers: { ...f.as(who), "content-type": "application/octet-stream" },
        payload: Buffer.from("x"),
      });
      expect(up.statusCode).toBe(403);
    }
  });

  it("only reads metadata.db / app.db from a server path", async () => {
    f = await family({ jobsAutostart: false }, { CONFIG_DIR: dir });
    writeFileSync(join(dir, "secret.txt"), "nope");
    const job = await runImport({ source: "calibre", dryRun: true, metadataDb: { path: join(dir, "secret.txt") } });
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/must end in metadata\.db/);
  });
});

describe("Calibre import", () => {
  it("dry-runs, then copies series, tags, identifiers and covers onto scanned books", async () => {
    f = await family({ jobsAutostart: false }, { CONFIG_DIR: join(dir, "config") });
    const lib = join(dir, "calibre");
    makeCalibre(lib);
    // Scanned under /books/Calibre/…: matched by the path tail.
    const mist = fileBook("Mistborn", "Calibre/Brandon Sanderson/Mistborn (1)/Mistborn_ The Final Empire - Brandon Sanderson.epub", ["Brandon Sanderson"]);
    const hobbit = fileBook("Hobbit", "Calibre/J. R. R. Tolkien/The Hobbit (2)/The Hobbit - J. R. R. Tolkien.epub", ["J.R.R. Tolkien"], { publisher: "Allen & Unwin" });

    const dry = await runImport({ source: "calibre", dryRun: true, metadataDb: { path: lib } });
    expect(dry.status).toBe("done");
    expect(dry.report.counts).toEqual({ matched: 0, new: 0, skipped: 1, conflict: 2 });
    expect(dry.report.items.find((i: { title: string }) => i.title.startsWith("Not Scanned")).detail).toMatch(/No file/);
    // Nothing written.
    expect(f.db.select().from(books).where(eq(books.id, mist)).get()!.title).toBe("Mistborn");
    expect(f.db.select().from(bookSeries).all()).toHaveLength(0);

    const real = await runImport({ source: "calibre", dryRun: false, metadataDb: { path: lib } });
    expect(real.report.counts).toEqual({ matched: 0, new: 0, skipped: 1, conflict: 2 });
    const m = f.db.select().from(books).where(eq(books.id, mist)).get()!;
    expect(m).toMatchObject({
      title: "Mistborn: The Final Empire",
      isbn13: "9780765311788",
      publisher: "Tor",
      language: "en",
      publishedYear: 2006,
      description: "The Lord Ruler reigns.",
    });
    expect(m.coverPath).toMatch(/^covers\//);
    const s = f.db.select({ name: series.name, position: bookSeries.position }).from(bookSeries).innerJoin(series, eq(series.id, bookSeries.seriesId)).where(eq(bookSeries.bookId, mist)).all();
    expect(s).toEqual([{ name: "Mistborn", position: 1 }]);
    expect(f.db.select().from(bookIdentifiers).where(eq(bookIdentifiers.bookId, hobbit)).all().map((r) => r.type).sort()).toEqual(["calibre", "goodreads"]);
    // Calibre wins by default; the 1st of January year 101 isn't a real year.
    const h = f.db.select().from(books).where(eq(books.id, hobbit)).get()!;
    expect(h.title).toBe("The Hobbit");
    expect(h.publishedYear).toBeNull();
    expect(h.publisher).toBe("Allen & Unwin");

    // Running it again finds the same books through the saved links, with nothing left to change.
    const again = await runImport({ source: "calibre", dryRun: true, metadataDb: { path: lib } });
    expect(again.report.counts).toEqual({ matched: 2, new: 0, skipped: 1, conflict: 0 });
  });

  it("keeps Bookbandit's values with fill-gaps and works from an uploaded metadata.db", async () => {
    f = await family({ jobsAutostart: false }, { CONFIG_DIR: join(dir, "config") });
    const lib = join(dir, "calibre");
    makeCalibre(lib);
    const hobbit = fileBook("Hobbit", "books/The Hobbit (2)/The Hobbit - J. R. R. Tolkien.epub", ["J. R. R. Tolkien"]);
    const { readFileSync } = await import("node:fs");
    const uploadId = await upload(readFileSync(join(lib, "metadata.db")), "metadata.db");
    const job = await runImport({ source: "calibre", dryRun: false, metadataDb: { uploadId }, overwrite: "fill-gaps" });
    expect(job.status).toBe("done");
    expect(job.report.warnings.join(" ")).toMatch(/Covers weren't copied/);
    expect(f.db.select().from(books).where(eq(books.id, hobbit)).get()!.title).toBe("Hobbit");
  });
});

describe("Calibre-Web import", () => {
  it("brings read status, Kobo positions and shelves for mapped people", async () => {
    f = await family({ jobsAutostart: false }, { CONFIG_DIR: join(dir, "config") });
    const lib = join(dir, "calibre");
    makeCalibre(lib);
    const mist = fileBook("Mistborn", "Brandon Sanderson/Mistborn (1)/Mistborn_ The Final Empire - Brandon Sanderson.epub", ["Brandon Sanderson"]);
    const hobbit = fileBook("Hobbit", "J. R. R. Tolkien/The Hobbit (2)/The Hobbit - J. R. R. Tolkien.epub", ["J. R. R. Tolkien"]);
    makeCalibreWeb(join(lib, "app.db"));

    const dry = await runImport({ source: "calibre-web", dryRun: true, appDb: { path: join(lib, "app.db") }, metadataDb: { path: lib } });
    expect(dry.status, dry.error).toBe("done");
    const people = Object.fromEntries(dry.report.people.map((p: { name: string; userId: string | null }) => [p.name, p.userId]));
    expect(people).toEqual({ admin: f.ids.admin, emma: f.ids.kid, stranger: null });
    expect(f.db.select().from(readingProgress).all()).toHaveLength(0);

    // The admin maps "stranger" to nobody and keeps the guesses.
    const ids = Object.fromEntries(dry.report.people.map((p: { id: string; userId: string | null }) => [p.id, p.userId]));
    const real = await runImport({ source: "calibre-web", dryRun: false, appDb: { path: join(lib, "app.db") }, metadataDb: { path: lib }, people: ids });
    expect(real.report.counts.conflict).toBe(0);

    const adminProg = f.db.select().from(readingProgress).where(and(eq(readingProgress.userId, f.ids.admin), eq(readingProgress.bookId, mist))).get()!;
    expect(adminProg).toMatchObject({ finished: true, percent: 1, clientUpdatedAt: Date.UTC(2024, 2, 1, 10) });
    const kidProg = f.db.select().from(readingProgress).where(and(eq(readingProgress.userId, f.ids.kid), eq(readingProgress.bookId, hobbit))).get()!;
    expect(kidProg).toMatchObject({ finished: false, percent: 0.4 });
    expect(f.db.select().from(readingHistory).where(eq(readingHistory.userId, f.ids.admin)).get()).toMatchObject({
      status: "read",
      readCount: 2,
      startedAt: Date.UTC(2024, 1, 1, 10),
      source: "calibre-web",
    });

    const cols = f.db.select().from(collections).all();
    expect(cols.map((c) => [c.name, c.ownerId]).sort()).toEqual([
      ["Bedtime", f.ids.kid],
      ["Family favourites", null],
    ]);
    const fav = cols.find((c) => c.name === "Family favourites")!;
    expect(f.db.select().from(collectionBooks).where(eq(collectionBooks.collectionId, fav.id)).all()).toHaveLength(2);

    // A newer position in Bookbandit wins over the import.
    f.db.update(readingProgress).set({ percent: 0.8, clientUpdatedAt: Date.UTC(2025, 0, 1) }).where(eq(readingProgress.userId, f.ids.kid)).run();
    const third = await runImport({ source: "calibre-web", dryRun: false, appDb: { path: join(lib, "app.db") }, people: ids });
    expect(third.status, third.error).toBe("done");
    expect(third.report.counts.conflict).toBe(1);
    expect(f.db.select().from(readingProgress).where(eq(readingProgress.userId, f.ids.kid)).get()!.percent).toBe(0.8);
  });
});

const GOODREADS = `Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies
68428,"Mistborn: The Final Empire (Mistborn, #1)",Brandon Sanderson,"Sanderson, Brandon",,"=""076531178X""","=""9780765311788""",5,4.47,Tor,Paperback,541,2006,2006,2023/05/02,2023/01/10,"favorites, read","favorites (#3), read (#120)",read,"Loved it, <br/>really.",,,2,0
5907,The Hobbit,J.R.R. Tolkien,"Tolkien, J.R.R.",,"=""""","=""""",0,4.29,Houghton,Paperback,366,2002,1937,,2024/02/01,to-read,to-read (#4),to-read,,,,0,0
1,Unowned Book,Some Writer,"Writer, Some",,"=""""","=""""",3,3.9,,,,,,2022/12/24,2022/12/01,read,read (#1),read,,,,1,0
`;

describe("Goodreads and StoryGraph", () => {
  it("parses Goodreads and StoryGraph exports", () => {
    const g = readHistoryCsv(GOODREADS);
    expect(g.flavor).toBe("goodreads");
    expect(g.rows[0]).toMatchObject({
      goodreadsId: "68428",
      isbn13: "9780765311788",
      status: "read",
      stars: 5,
      shelves: ["favorites"],
      readCount: 2,
      finishedAt: Date.UTC(2023, 4, 2),
      review: "Loved it, \nreally.",
    });
    expect(g.rows[1]).toMatchObject({ status: "to-read", stars: null, finishedAt: null, isbn13: null });

    const sg = readHistoryCsv(
      `Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Read Count,Moods,Pace,Star Rating,Review,Content Warnings,Tags,Owned?
The Hobbit,"J.R.R. Tolkien",,9780547928227,paperback,read,2023/01/01,2023/02/10,"2020/01/01-2020/01/09, 2023/02/01-2023/02/10",2,adventurous,fast,4.5,,,"classics, cozy",No
Dune,Frank Herbert,,9780441013593,paperback,did-not-finish,2023/03/01,,,0,,,,,,,No`,
    );
    expect(sg.flavor).toBe("storygraph");
    expect(sg.rows[0]).toMatchObject({ stars: 4.5, startedAt: Date.UTC(2023, 1, 1), finishedAt: Date.UTC(2023, 1, 10), shelves: ["classics", "cozy"], readCount: 2 });
    expect(sg.rows[1]!.status).toBe("did-not-finish");
  });

  it("imports one person's history, marks books finished, and round-trips through the export", async () => {
    f = await family({ jobsAutostart: false }, { CONFIG_DIR: dir });
    const mist = fileBook("Mistborn: The Final Empire", "m.epub", ["Brandon Sanderson"], { isbn13: "9780765311788" });
    const hobbit = fileBook("The Hobbit", "h.epub", ["J. R. R. Tolkien"]);
    const uploadId = await upload(GOODREADS, "goodreads.csv");
    const body = { source: "goodreads", file: { uploadId }, userId: f.ids.adult, shelves: true };

    const dry = await runImport({ ...body, dryRun: true });
    expect(dry.report.source).toBe("goodreads");
    expect(dry.report.counts).toEqual({ matched: 2, new: 1, skipped: 0, conflict: 0 });
    expect(f.db.select().from(readingHistory).all()).toHaveLength(0);

    const real = await runImport({ ...body, dryRun: false });
    expect(real.report.counts).toEqual({ matched: 2, new: 1, skipped: 0, conflict: 0 });
    expect(f.db.select().from(readingProgress).where(eq(readingProgress.bookId, mist)).get()).toMatchObject({ userId: f.ids.adult, finished: true });
    const want = f.db.select().from(collections).where(eq(collections.name, "Want to read")).get()!;
    expect(want.ownerId).toBe(f.ids.adult);
    expect(f.db.select().from(collectionBooks).where(eq(collectionBooks.collectionId, want.id)).all().map((r) => r.bookId)).toEqual([hobbit]);
    expect(f.db.select().from(collections).where(eq(collections.name, "favorites")).get()).toBeTruthy();

    const exp = await f.app.inject({ url: "/api/reading-history/export.csv", headers: f.as("adult") });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers["content-type"]).toMatch(/text\/csv/);
    const csv = exp.body;
    expect(csv.split("\n")[0]).toBe(
      "Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies",
    );
    const parsed = readHistoryCsv(csv);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows.find((r) => r.goodreadsId === "68428")).toMatchObject({ stars: 5, finishedAt: Date.UTC(2023, 4, 2), shelves: ["favorites"], readCount: 2 });

    // Importing the export again changes nothing.
    const back = await runImport({ ...body, file: { uploadId: await upload(csv) }, dryRun: false });
    expect(back.report.counts).toEqual({ matched: 0, new: 0, skipped: 3, conflict: 0 });
    expect(f.db.select().from(readingHistory).all()).toHaveLength(3);
  });

  it("exports through the content lock", async () => {
    f = await family({ jobsAutostart: false }, { CONFIG_DIR: dir });
    const kidBook = f.book("Kid Book", "kids");
    const adultBook = f.book("Adult Book", "adult");
    for (const [bookId, title] of [[kidBook, "Kid Book"], [adultBook, "Adult Book"], [null, "Somewhere Else"]] as const) {
      f.db.insert(readingHistory).values({ userId: f.ids.kid, bookId, title, status: "read", source: "goodreads", sourceKey: title }).run();
    }
    const kid = await f.app.inject({ url: "/api/reading-history/export.csv", headers: f.as("kid") });
    expect(kid.body).toContain("Kid Book");
    expect(kid.body).not.toContain("Adult Book");
    expect(kid.body).not.toContain("Somewhere Else");
    // Someone else's history: admins only.
    expect((await f.app.inject({ url: `/api/reading-history/export.csv?userId=${f.ids.kid}`, headers: f.as("parent") })).statusCode).toBe(403);
    const admin = await f.app.inject({ url: `/api/reading-history/export.csv?userId=${f.ids.kid}`, headers: f.as("admin") });
    expect(admin.body).toContain("Adult Book");
  });
});

describe("Google Play Books import", () => {
  it("reads CSV and Google Books JSON", () => {
    expect(volumeIdFrom("https://play.google.com/store/books/details?id=abcDEF123456&hl=en")).toBe("abcDEF123456");
    const csv = readPlayLibrary("Title,Author,ISBN,Volume ID\nThe Martian,Andy Weir,9780553418026,qwertyuiop12\n");
    expect(csv.rows[0]).toMatchObject({ title: "The Martian", authors: ["Andy Weir"], isbn13: "9780553418026", volumeId: "qwertyuiop12" });
    const json = readPlayLibrary(JSON.stringify({ items: [{ id: "zxcvbnmasdfg", volumeInfo: { title: "Dune", authors: ["Frank Herbert"], publishedDate: "1965" } }] }));
    expect(json.rows[0]).toMatchObject({ title: "Dune", volumeId: "zxcvbnmasdfg", publishedYear: 1965 });
  });

  it("adds metadata-only entries with a Google Play link, behind the content lock", async () => {
    f = await family({ jobsAutostart: false }, { CONFIG_DIR: dir });
    const owned = fileBook("Dune", "dune.epub", ["Frank Herbert"]);
    const uploadId = await upload("Title,Author,Volume ID\nThe Martian,Andy Weir,qwertyuiop12\nDune,Frank Herbert,zxcvbnmasdfg\n");
    const dry = await runImport({ source: "google-play", file: { uploadId }, dryRun: true });
    expect(dry.report.counts).toEqual({ matched: 1, new: 1, skipped: 0, conflict: 0 });
    const real = await runImport({ source: "google-play", file: { uploadId }, dryRun: false });
    expect(real.report.counts).toEqual({ matched: 1, new: 1, skipped: 0, conflict: 0 });
    const martian = f.db.select().from(books).where(eq(books.title, "The Martian")).get()!;
    expect(martian).toMatchObject({ approved: true, rating: null, kindleOnly: false, googleBooksId: "qwertyuiop12" });

    const link = await f.app.inject({ url: `/api/books/${martian.id}/elsewhere`, headers: f.as("adult") });
    expect(link.json()).toEqual({ googlePlay: { url: "https://play.google.com/store/books/details?id=qwertyuiop12" } });
    // Unrated counts as adult: a kid gets 404.
    expect((await f.app.inject({ url: `/api/books/${martian.id}/elsewhere`, headers: f.as("kid") })).statusCode).toBe(404);
    expect((await f.app.inject({ url: `/api/books/${owned}/elsewhere`, headers: f.as("adult") })).json()).toEqual({
      googlePlay: { url: "https://play.google.com/store/books/details?id=zxcvbnmasdfg" },
    });
    const again = await runImport({ source: "google-play", file: { uploadId }, dryRun: true });
    expect(again.report.counts).toEqual({ matched: 0, new: 0, skipped: 2, conflict: 0 });
  });
});

describe("Kavita import", () => {
  it("brings progress and collections through the API, per API key", async () => {
    const calls: string[] = [];
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
      if (u.pathname === "/kavita/api/Plugin/authenticate") {
        return u.searchParams.get("apiKey") === "good-key-123" ? json({ username: "emma-k", token: "tok" }) : json({}, 401);
      }
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
      if (u.pathname === "/kavita/api/Series/all-v2") return json([{ id: 10, name: "Comic Saga", pagesRead: 12 }, { id: 11, name: "Unread", pagesRead: 0 }]);
      if (u.pathname === "/kavita/api/Series/volumes") {
        const id = u.searchParams.get("seriesId");
        const file = id === "10" ? "/manga/Comic Saga/Comic Saga 01.pdf" : "/manga/Unread/Unread 01.cbz";
        return json([{ chapters: [{ id: Number(id) * 10, pages: 24, pagesRead: id === "10" ? 12 : 0, lastReadingProgressUtc: "2024-05-01T08:00:00Z", files: [{ filePath: file, bytes: 1000 }] }] }]);
      }
      if (u.pathname === "/kavita/api/Collection") return json([{ id: 1, title: "Bedtime comics" }]);
      if (u.pathname === "/kavita/api/Series/series-by-collection") return json([{ id: 10 }]);
      return json({}, 404);
    };
    f = await family({ jobsAutostart: false, imports: { fetchImpl } }, { CONFIG_DIR: dir });
    const saga = fileBook("Comic Saga 01", "Comics/Comic Saga/Comic Saga 01.pdf", ["Artist"]);
    const body = {
      source: "kavita",
      url: "http://kavita.local:5000/kavita/",
      accounts: [
        { apiKey: "good-key-123", userId: f.ids.kid },
        { apiKey: "bad-key-4567", userId: f.ids.adult },
      ],
    };
    const real = await runImport({ ...body, dryRun: false });
    expect(real.status, real.error).toBe("done");
    expect(real.report.warnings.join(" ")).toMatch(/API key 2: Kavita didn't accept/);
    expect(real.report.people).toEqual([{ id: "0", name: "emma-k", userId: f.ids.kid, guessed: false }]);
    expect(f.db.select().from(readingProgress).where(eq(readingProgress.bookId, saga)).get()).toMatchObject({
      userId: f.ids.kid,
      percent: 0.5,
      finished: false,
      locator: { kind: "page", page: 11, totalPages: 24 },
      clientUpdatedAt: Date.UTC(2024, 4, 1, 8),
    });
    const col = f.db.select().from(collections).where(eq(collections.name, "Bedtime comics")).get()!;
    expect(col.ownerId).toBe(f.ids.kid);
    expect(calls).not.toContain("GET /kavita/api/Series/volumes?seriesId=11");
    // The key is sealed in the stored job.
    const job = f.db.all<{ payload: string }>(`select payload from jobs where type = 'import'` as never)[0];
    expect(JSON.stringify(job)).not.toContain("good-key-123");
  });
});

describe("ISBNdb provider", () => {
  it("is asked only with a key, and fills in from its answer", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push(new URL(url).host);
      if (url.startsWith("https://api2.isbndb.com/book/9780765311788")) {
        expect((init?.headers as Record<string, string>).authorization).toBe("isbn-key");
        return new Response(
          JSON.stringify({ book: { title: "Mistborn", authors: ["Sanderson, Brandon"], isbn13: "9780765311788", publisher: "Tor", pages: 541, date_published: "2006-07-17" } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    };
    const without = await lookupOnline({ isbn13: "9780765311788" }, { fetch: fetchImpl });
    expect(seen).not.toContain("api2.isbndb.com");
    expect(without.matches).toHaveLength(0);
    const withKey = await lookupOnline({ isbn13: "9780765311788" }, { fetch: fetchImpl, isbndbKey: "isbn-key" });
    expect(withKey.matches[0]).toMatchObject({ provider: "isbndb", authors: ["Brandon Sanderson"], pageCount: 541, publishedYear: 2006 });
  });

  it("keeps the key sealed in settings", async () => {
    f = await family({ jobsAutostart: false }, { CONFIG_DIR: dir });
    const put = await f.app.inject({ method: "PUT", url: "/api/admin/settings/metadata", headers: f.as("admin"), payload: { online: true, isbndbKey: "isbn-key" } });
    expect(put.json()).toMatchObject({ hasIsbndbKey: true });
    expect(put.body).not.toContain("isbn-key");
  });
});

describe("helpers", () => {
  it("parses the date shapes the sources use", () => {
    expect(parseDate("2023/05/02")).toBe(Date.UTC(2023, 4, 2));
    expect(parseDate("2024-03-01 10:00:00.123456")).toBe(Date.UTC(2024, 2, 1, 10));
    expect(parseDate("2024-05-01T08:00:00Z")).toBe(Date.UTC(2024, 4, 1, 8));
    expect(parseDate("")).toBeNull();
    expect(parseDate("0101-01-01")).toBeNull();
  });

  it("needs more than a bare file name when several files share it", async () => {
    f = await family({ jobsAutostart: false }, { CONFIG_DIR: dir });
    const a = fileBook("A", "x/one/book.epub", ["A"]);
    fileBook("B", "x/two/book.epub", ["B"]);
    const solo = fileBook("C", "deep/solo.epub", ["C"]);
    const index = new FileIndex(f.db);
    expect(index.byPath("/mnt/elsewhere/book.epub")).toBeUndefined();
    expect(index.byPath("/calibre/one/book.epub")?.bookId).toBe(a);
    expect(index.byPath("/other/solo.epub")?.bookId).toBe(solo);
  });
});
