import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { authors, bookAuthors, bookFiles, books, bookSeries, bookTags, bookmarks, readingProgress, series, tags } from "../src/db/schema.js";
import { readEpub } from "../src/metadata/epub.js";
import { sha256File } from "../src/library/hash.js";
import { findWorkGroups } from "../src/librarian/duplicates.js";
import { rewriteOpf } from "../src/librarian/epub-write.js";
import type { KepubConverter } from "../src/kobo/kepub.js";
import { family, type Family } from "./helpers.js";
import { makeEpub, PNG, tempDir } from "./library/fixtures.js";

/** A tiny MOBI: PalmDB header with BOOKMOBI and a PalmDOC record saying "no encryption" (or DRM). */
function mobiBytes(drm = false): Buffer {
  const buf = Buffer.alloc(200);
  buf.write("Some Book", 0, "latin1");
  buf.write("BOOKMOBI", 60, "latin1");
  buf.writeUInt32BE(100, 78);
  buf.writeUInt16BE(drm ? 2 : 0, 100 + 12);
  return buf;
}

let f: Family;
let booksDir: string;
let configDir: string;
const kepubCalls: string[] = [];
const fakeKepub = {
  isAvailable: async () => true,
  convert: async (abs: string) => {
    kepubCalls.push(abs);
    return `${abs}.kepub`;
  },
} as unknown as KepubConverter;
let convertCalls = 0;

beforeEach(async () => {
  booksDir = await tempDir("bb-lib-books-");
  configDir = await tempDir("bb-lib-config-");
  kepubCalls.length = 0;
  convertCalls = 0;
  f = await family(
    {
      jobsAutostart: false,
      ereader: { kepub: fakeKepub },
      librarian: {
        tools: async () => ({ ebookConvert: true, kepubify: true }),
        // Stands in for ebook-convert: writes a real EPUB to the output path.
        convert: async (_input, output) => {
          convertCalls++;
          await makeEpub(output, { title: "Converted", authors: ["Ada Brightwater"] });
        },
      },
    },
    { BOOKS_DIR: booksDir, CONFIG_DIR: configDir, METADATA_ONLINE: "false", LIBRARY_SCAN_ON_START: "false" },
  );
});

afterEach(async () => {
  await f.close();
});

const call = (who: "admin" | "parent" | "adult" | "kid", method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  f.app.inject({ method, url, headers: f.as(who), payload: payload as object });

function author(bookId: string, name: string) {
  const [a] = f.db.insert(authors).values({ name, sortName: name }).onConflictDoNothing().returning().all();
  const id = a?.id ?? f.db.select().from(authors).where(eq(authors.name, name)).get()!.id;
  f.db.insert(bookAuthors).values({ bookId, authorId: id }).run();
}

async function fileFor(bookId: string, relPath: string, data?: Buffer) {
  const abs = join(booksDir, relPath);
  await mkdir(join(abs, ".."), { recursive: true });
  if (data) await writeFile(abs, data);
  else await makeEpub(abs, { title: relPath, salt: relPath.replace(/\W/g, "").slice(0, 12) });
  const s = await stat(abs);
  const format = relPath.endsWith(".mobi") ? "mobi" : "epub";
  return f.db
    .insert(bookFiles)
    .values({ bookId, relPath, format, sizeBytes: s.size, mtimeMs: Math.floor(s.mtimeMs), sha256: await sha256File(abs) })
    .returning()
    .all()[0]!;
}

describe("librarian access", () => {
  it("is admin-only, for every librarian endpoint", async () => {
    const id = f.book("Locked", "explicit");
    const probes: [Parameters<typeof call>[1], string, unknown?][] = [
      ["GET", "/api/admin/librarian/books"],
      ["GET", "/api/admin/librarian/duplicates"],
      ["POST", "/api/admin/librarian/duplicates/merge", { keepId: id, otherIds: [id] }],
      ["POST", "/api/admin/librarian/bulk", { ids: [id], rating: "kids" }],
      ["GET", "/api/admin/librarian/tools"],
      ["POST", "/api/admin/librarian/convert", { bookIds: [id] }],
      ["GET", `/api/admin/librarian/books/${id}/covers`],
      ["GET", `/api/admin/librarian/books/${id}/cover`],
      ["GET", "/api/admin/librarian/health"],
      ["PUT", "/api/admin/librarian/settings", { writeMetadata: true }],
    ];
    for (const who of ["kid", "parent", "adult"] as const) {
      for (const [method, url, body] of probes) {
        const res = await call(who, method, url, body);
        expect(res.statusCode, `${who} ${method} ${url}`).toBe(403);
      }
    }
    expect(f.db.select().from(books).where(eq(books.id, id)).get()!.rating).toBe("explicit");
  });
});

describe("duplicates", () => {
  it("groups the same work and merges formats into one book", async () => {
    const a = f.book("Storm Over Pebble Bay", "middle_grade");
    const b = f.book("Storm over Pebble Bay!", null, { approved: false });
    const other = f.book("Storm Over Pebble Bay", "adult");
    author(a, "Ada Brightwater");
    author(b, "Ada Brightwater");
    author(other, "Someone Else");
    await fileFor(a, "Ada/Storm.epub");
    await fileFor(b, "_incoming/storm.mobi", mobiBytes());
    f.db.insert(readingProgress).values({ userId: f.ids.kid, bookId: b, locator: {}, percent: 0.4, clientUpdatedAt: 5, serverUpdatedAt: 5 }).run();

    const list = (await call("admin", "GET", "/api/admin/librarian/duplicates")).json();
    expect(list.sameWork).toHaveLength(1);
    expect(list.sameWork[0].reason).toBe("title_author");
    // The approved book with a reader comes first; "Someone Else"'s book isn't in the group.
    expect(list.sameWork[0].books.map((x: { id: string }) => x.id).sort()).toEqual([a, b].sort());

    const res = await call("admin", "POST", "/api/admin/librarian/duplicates/merge", { keepId: a, otherIds: [b] });
    expect(res.statusCode).toBe(200);
    expect(res.json().kept.files.map((x: { format: string }) => x.format).sort()).toEqual(["epub", "mobi"]);
    expect(f.db.select().from(books).where(eq(books.id, b)).get()).toBeUndefined();
    expect(f.db.select().from(readingProgress).where(eq(readingProgress.bookId, a)).get()?.percent).toBe(0.4);
    expect((await call("admin", "GET", "/api/admin/librarian/duplicates")).json().sameWork).toHaveLength(0);
  });

  it("keeps one and sets the other's files aside, moving bookmarks over", async () => {
    const a = f.book("Pixel Quest", "kids");
    const b = f.book("Pixel Quest", "kids");
    author(a, "Max Byte");
    author(b, "Max Byte");
    await fileFor(a, "Max Byte/Pixel Quest.epub");
    const dupe = await fileFor(b, "Downloads/Pixel Quest (1).epub");
    f.db.insert(bookmarks).values({ userId: f.ids.kid, bookId: b, kind: "bookmark", locator: {}, updatedAt: 1 }).run();

    const res = await call("admin", "POST", "/api/admin/librarian/duplicates/keep", { keepId: a, otherIds: [b] });
    expect(res.statusCode).toBe(200);
    expect(res.json().setAside).toEqual([".duplicates/Downloads/Pixel Quest (1).epub"]);
    await expect(stat(join(booksDir, dupe.relPath))).rejects.toThrow();
    await stat(join(booksDir, ".duplicates/Downloads/Pixel Quest (1).epub"));
    expect(res.json().kept.files).toHaveLength(1);
    expect(f.db.select().from(bookmarks).where(eq(bookmarks.bookId, a)).all()).toHaveLength(1);
  });

  it("removes extra copies of the same bytes but never the last one", async () => {
    const a = f.book("Copy Cat", "kids");
    const one = await fileFor(a, "Copy Cat.epub");
    await mkdir(join(booksDir, "backup"), { recursive: true });
    await copyFile(join(booksDir, one.relPath), join(booksDir, "backup/Copy Cat.epub"));
    const two = f.db.insert(bookFiles).values({ ...one, id: undefined, relPath: "backup/Copy Cat.epub" }).returning().all()[0]!;

    const list = (await call("admin", "GET", "/api/admin/librarian/duplicates")).json();
    expect(list.copies).toHaveLength(1);
    expect(list.copies[0].files.map((x: { relPath: string }) => x.relPath)).toEqual(["Copy Cat.epub", "backup/Copy Cat.epub"]);

    expect((await call("admin", "POST", "/api/admin/librarian/duplicates/copies", { fileIds: [one.id, two.id] })).statusCode).toBe(400);
    const res = await call("admin", "POST", "/api/admin/librarian/duplicates/copies", { fileIds: [two.id] });
    expect(res.statusCode).toBe(200);
    expect(f.db.select().from(bookFiles).where(eq(bookFiles.bookId, a)).all().map((x) => x.relPath)).toEqual(["Copy Cat.epub"]);
    expect((await call("admin", "GET", "/api/admin/librarian/duplicates")).json().copies).toHaveLength(0);
  });

  it("hides a group marked 'not duplicates' until it changes", async () => {
    const a = f.book("Home", "adult");
    const b = f.book("Home", "adult");
    author(a, "Writer One");
    author(b, "Writer One");
    expect((await call("admin", "POST", "/api/admin/librarian/duplicates/ignore", { bookIds: [b, a] })).statusCode).toBe(200);
    let list = (await call("admin", "GET", "/api/admin/librarian/duplicates")).json();
    expect(list.sameWork).toHaveLength(0);
    expect(list.ignored).toBe(1);
    const c = f.book("Home", "adult");
    author(c, "Writer One");
    list = (await call("admin", "GET", "/api/admin/librarian/duplicates")).json();
    expect(list.sameWork[0].books).toHaveLength(3);
    await call("admin", "DELETE", "/api/admin/librarian/duplicates/ignore");
    expect((await call("admin", "GET", "/api/admin/librarian/duplicates")).json().ignored).toBe(0);
  });

  it("finds groups by ISBN, title + author, and title with a missing author", () => {
    const rows = [
      { id: "1", title: "The Hobbit", isbn13: "9780000000001" },
      { id: "2", title: "Hobbit", isbn13: "9780000000001" },
      { id: "3", title: "Dune", isbn13: null },
      { id: "4", title: "Dune", isbn13: null },
      { id: "5", title: "Dune", isbn13: null },
      { id: "6", title: "Emma", isbn13: null },
    ];
    const by = new Map([
      ["3", ["Frank Herbert"]],
      ["4", ["Brian Herbert"]],
      ["5", []],
    ]);
    const groups = findWorkGroups(rows, by).map((g) => ({ ...g, ids: g.ids.sort() }));
    expect(groups).toContainEqual({ reason: "isbn", ids: ["1", "2"] });
    // 3 and 4 have different authors, but the author-less 5 could be either: one group, weakest reason.
    expect(groups).toContainEqual({ reason: "title", ids: ["3", "4", "5"] });
    expect(groups).toHaveLength(2);
  });
});

describe("duplicate groups and series volumes", () => {
  it("never groups different volumes, even through a copy with no number", () => {
    const rows = [
      { id: "4", title: "Diary of a Wimpy Villager", isbn13: null, volume: 4 },
      { id: "6", title: "Diary of a Wimpy Villager", isbn13: null, volume: 6 },
      { id: "x", title: "Diary of a Wimpy Villager", isbn13: null },
      { id: "6b", title: "Diary of a Wimpy Villager", isbn13: null, volume: 6 },
      { id: "a", title: "Emma", isbn13: "9780000000001" },
      { id: "b", title: "Emma", isbn13: "9780000000002" },
    ];
    const by = new Map(rows.map((r) => [r.id, ["Cube Kid"]]));
    const groups = findWorkGroups(rows, by).map((g) => g.ids.sort());
    // "x" joins one volume's group, never both; the two Emmas have different ISBNs.
    expect(groups).toHaveLength(2);
    expect(groups).toContainEqual(["6", "6b"]);
    expect(groups).toContainEqual(["4", "x"]);
  });
});

describe("bulk edit", () => {
  it("sets a series on ten books in order, and tags, rating, language and authors", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => f.book(`Pebble Bay ${i + 1}`, null));
    const res = await call("admin", "POST", "/api/admin/librarian/bulk", {
      ids,
      series: { name: "Pebble Bay", numbering: "sequence", start: 1 },
      tagsAdd: ["Summer reading"],
      rating: "middle_grade",
      language: "EN",
      authors: ["Ada Brightwater"],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(10);
    const s = f.db.select().from(series).where(eq(series.name, "Pebble Bay")).get()!;
    expect(s.adminManaged).toBe(true);
    const links = f.db.select().from(bookSeries).where(eq(bookSeries.seriesId, s.id)).all();
    expect(ids.map((id) => links.find((l) => l.bookId === id)?.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const b0 = f.db.select().from(books).where(eq(books.id, ids[0]!)).get()!;
    expect([b0.rating, b0.ratingSource, b0.language]).toEqual(["middle_grade", "admin", "en"]);
    const tag = f.db.select().from(tags).where(eq(tags.name, "Summer reading")).get()!;
    expect(tag.kind).toBe("custom");
    expect(f.db.select().from(bookTags).where(eq(bookTags.tagId, tag.id)).all()).toHaveLength(10);

    // Keep numbering, remove the tag, then take them out of the series.
    await call("admin", "POST", "/api/admin/librarian/bulk", { ids: ids.slice(0, 2), series: { name: "pebble bay", numbering: "keep" }, tagsRemove: ["summer READING"] });
    expect(f.db.select().from(bookSeries).where(eq(bookSeries.bookId, ids[1]!)).get()?.position).toBe(2);
    expect(f.db.select().from(bookTags).where(eq(bookTags.tagId, tag.id)).all()).toHaveLength(8);
    await call("admin", "POST", "/api/admin/librarian/bulk", { ids, series: null });
    expect(f.db.select().from(bookSeries).all()).toHaveLength(0);

    const list = (await call("admin", "GET", "/api/admin/librarian/books?q=ada&limit=5")).json();
    expect(list.total).toBe(10);
    expect(list.items[0].authors).toEqual(["Ada Brightwater"]);
  });

  it("answers 404 when a book is gone and 400 on bad input", async () => {
    const id = f.book("One", null);
    expect((await call("admin", "POST", "/api/admin/librarian/bulk", { ids: [id, "nope"], rating: "kids" })).statusCode).toBe(404);
    expect((await call("admin", "POST", "/api/admin/librarian/bulk", { ids: [id], rating: "everyone" })).statusCode).toBe(400);
    expect(f.db.select().from(books).where(eq(books.id, id)).get()!.rating).toBeNull();
  });
});

describe("conversion", () => {
  it("converts a MOBI to an EPUB next to it that opens in the reader", async () => {
    const id = f.book("Night Train", "adult");
    await fileFor(id, "Lena Cole/Night Train.mobi", mobiBytes());
    const tools = (await call("admin", "GET", "/api/admin/librarian/tools")).json();
    expect(tools.needsConversion).toBe(1);

    const res = await call("admin", "POST", "/api/admin/librarian/convert", { bookIds: [id] });
    expect(res.statusCode).toBe(202);
    expect(res.json().queued).toHaveLength(1);
    await f.app.jobs.drain();
    expect(f.app.jobs.get(res.json().queued[0].jobId)?.status).toBe("done");

    const epub = f.db.select().from(bookFiles).where(eq(bookFiles.format, "epub")).get()!;
    expect(epub.bookId).toBe(id);
    expect(epub.relPath).toBe("Lena Cole/Night Train.epub");
    expect(epub.sha256).toBe(await sha256File(join(booksDir, epub.relPath)));
    const file = await call("adult", "GET", `/api/books/${id}/files/${epub.id}`);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toContain("application/epub+zip");
    expect((await readEpub(join(booksDir, epub.relPath))).title).toBe("Converted");

    // Already has an EPUB now: skipped.
    const again = (await call("admin", "POST", "/api/admin/librarian/convert", { bookIds: [id] })).json();
    expect(again.skipped[0].reason).toMatch(/Already/);
  });

  it("never converts a DRM-protected file", async () => {
    const id = f.book("Locked Kindle Book", "adult");
    await fileFor(id, "Kindle/locked.mobi", mobiBytes(true));
    const { queued } = (await call("admin", "POST", "/api/admin/librarian/convert", { bookIds: [id] })).json();
    await f.app.jobs.drain();
    const job = f.app.jobs.get(queued[0].jobId)!;
    expect(job.status).toBe("failed");
    expect(job.lastError).toMatch(/DRM/);
    expect(convertCalls).toBe(0);
  });

  it("prepares EPUBs for Kobo ahead of time", async () => {
    const id = f.book("Kobo Book", "adult");
    await fileFor(id, "Kobo Book.epub");
    const res = await call("admin", "POST", "/api/admin/librarian/kepub", {});
    expect(res.statusCode).toBe(202);
    await f.app.jobs.drain();
    expect(kepubCalls).toEqual([join(booksDir, "Kobo Book.epub")]);
  });

  it("writes details into the EPUB only when switched on", async () => {
    const id = f.book("Old Title", "kids");
    const file = await fileFor(id, "old.epub");
    expect((await call("admin", "POST", "/api/admin/librarian/write-metadata", { bookIds: [id] })).statusCode).toBe(409);
    expect((await call("admin", "PUT", "/api/admin/librarian/settings", { writeMetadata: true })).json()).toEqual({ writeMetadata: true });

    f.db.update(books).set({ title: "New Title", isbn13: "9781234567897" }).where(eq(books.id, id)).run();
    await call("admin", "POST", "/api/admin/librarian/bulk", { ids: [id], authors: ["Juniper Vale"], series: { name: "Owls", numbering: "sequence", start: 3 } });
    await f.app.jobs.drain();
    const meta = await readEpub(join(booksDir, "old.epub"));
    expect(meta).toMatchObject({ title: "New Title", authors: ["Juniper Vale"], series: "Owls", seriesPosition: 3, isbn13: "9781234567897" });
    const row = f.db.select().from(bookFiles).where(eq(bookFiles.id, file.id)).get()!;
    expect(row.sha256).toBe(await sha256File(join(booksDir, "old.epub")));
    expect(row.sha256).not.toBe(file.sha256);
    // Still a valid EPUB: mimetype first.
    const bytes = await readFile(join(booksDir, "old.epub"));
    expect(bytes.subarray(30, 38).toString()).toBe("mimetype");
  });

  it("rewrites only the fields it manages in the OPF", () => {
    const opf = `<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
  <dc:title>Old</dc:title><dc:creator id="c1">Someone</dc:creator><meta refines="#c1" property="role">aut</meta>
  <dc:creator opf:role="ill">Illustrator Person</dc:creator><dc:identifier id="id">urn:uuid:1</dc:identifier>
  <meta name="calibre:series" content="Old Series"/></metadata><manifest/></package>`;
    const out = rewriteOpf(opf, { title: "A & B", authors: ["Ann"], series: null });
    expect(out).toContain("<dc:title>A &amp; B</dc:title>");
    expect(out).toContain('<dc:creator opf:role="aut">Ann</dc:creator>');
    expect(out).toContain("Illustrator Person");
    expect(out).toContain('<dc:identifier id="id">urn:uuid:1</dc:identifier>');
    expect(out).not.toContain("Someone");
    expect(out).not.toContain('refines="#c1"');
    expect(out).not.toContain("Old Series");
  });
});

describe("covers", () => {
  it("uploads a cropped image, takes one from the book's file, and rejects non-images", async () => {
    const id = f.book("Cover Me", "kids");
    const epubPath = join(booksDir, "cover-me.epub");
    await makeEpub(epubPath, { title: "Cover Me", cover: true });
    const s = await stat(epubPath);
    const [file] = f.db.insert(bookFiles).values({ bookId: id, relPath: "cover-me.epub", format: "epub", sizeBytes: s.size }).returning().all();

    const cands = (await call("admin", "GET", `/api/admin/librarian/books/${id}/covers`)).json();
    expect(cands.current).toBeNull();
    expect(cands.candidates).toEqual([expect.objectContaining({ source: "file", fileId: file!.id })]);
    const fromFileImg = await call("admin", "GET", cands.candidates[0].url);
    expect(fromFileImg.headers["content-type"]).toBe("image/png");

    const pngUpload = `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(2048)]).toString("base64")}`;
    const up = await call("admin", "POST", `/api/admin/librarian/books/${id}/cover`, { image: pngUpload });
    expect(up.statusCode).toBe(200);
    expect(up.json().book.coverPath).toBe(`covers/${id}.png`);
    expect((await call("kid", "GET", `/api/books/${id}/cover`)).statusCode).toBe(200);

    expect((await call("admin", "POST", `/api/admin/librarian/books/${id}/cover`, { image: Buffer.from("not an image at all, sorry").toString("base64") })).statusCode).toBe(422);
    expect((await call("admin", "POST", `/api/admin/librarian/books/${id}/cover`, { fileId: file!.id })).statusCode).toBe(200);
  });

  it("downloads a picked lookup cover", async () => {
    await f.close();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096)]);
    f = await family(
      {
        jobsAutostart: false,
        librarian: {
          tools: async () => ({ ebookConvert: false, kepubify: false }),
          fetchImpl: (async () => new Response(new Uint8Array(jpeg), { headers: { "content-type": "image/jpeg" } })) as typeof fetch,
        },
      },
      { BOOKS_DIR: booksDir, CONFIG_DIR: configDir, METADATA_ONLINE: "false" },
    );
    const id = f.book("Remote", "kids");
    const res = await call("admin", "POST", `/api/admin/librarian/books/${id}/cover`, { url: "https://covers.example.com/x.jpg" });
    expect(res.statusCode).toBe(200);
    expect(res.json().book.coverPath).toBe(`covers/${id}.jpg`);
    expect((await call("admin", "POST", "/api/admin/librarian/convert", { bookIds: [id] })).statusCode).toBe(409);
  });
});

describe("library health", () => {
  it("counts books missing a cover, rating, author or files, and checks files on disk", async () => {
    const good = f.book("Good", "kids", { coverPath: "covers/x.png" });
    author(good, "Someone");
    await fileFor(good, "good.epub");
    const broken = f.book("Broken", null);
    await fileFor(broken, "broken.epub", Buffer.from("PK this is not really a zip file at all"));
    const gone = f.book("Gone", "adult");
    f.db.insert(bookFiles).values({ bookId: gone, relPath: "gone.epub", format: "epub", sizeBytes: 10 }).run();
    f.book("Kindle only", "adult", { kindleOnly: true });
    f.book("No files", "adult");

    const h = (await call("admin", "GET", "/api/admin/librarian/health")).json();
    expect(h.counts).toEqual({ no_cover: 4, no_rating: 1, no_author: 4, no_files: 1 });
    expect(h.files).toBeNull();

    expect((await call("admin", "POST", "/api/admin/librarian/health/check")).statusCode).toBe(202);
    await f.app.jobs.drain();
    const after = (await call("admin", "GET", "/api/admin/librarian/health")).json();
    expect(after.files.filesChecked).toBe(3);
    const problems = Object.fromEntries(after.files.problems.map((p: { title: string; problem: string }) => [p.title, p.problem]));
    expect(problems).toEqual({ Broken: "unreadable", Gone: "missing" });

    const noRating = (await call("admin", "GET", "/api/admin/librarian/books?check=no_rating")).json();
    expect(noRating.items.map((b: { title: string }) => b.title)).toEqual(["Broken"]);
  });
});
