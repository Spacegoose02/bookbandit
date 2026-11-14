import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import yazl from "yazl";
import { family, type Family } from "./helpers.js";
import { tempDir, PNG } from "./library/fixtures.js";
import { authors, bookAuthors, bookFiles, books, bookSeries, kidShelf, readingProgress, series } from "../src/db/schema.js";
import { KepubConverter } from "../src/kobo/kepub.js";
import { partialMd5 } from "../src/koreader/digest.js";
import { cfiToXpointer, parseCfi, xpointerToCfi } from "../src/ereader/epub-position.js";
import { decodeSyncToken } from "../src/kobo/routes.js";

const md5 = (s: string | Buffer) => createHash("md5").update(s).digest("hex");

function zip(entries: { name: string; data: string | Buffer; store?: boolean }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const e of entries) z.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), e.name, { compress: !e.store });
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on("data", (c: Buffer) => chunks.push(c));
    z.outputStream.on("error", reject);
    z.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** Two chapters; chapter 2 has a wrapper div so element paths have some depth. */
async function twoChapterEpub(salt: string): Promise<Buffer> {
  const xhtml = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;
  return zip([
    { name: "mimetype", data: "application/epub+zip", store: true },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    {
      name: "OEBPS/content.opf",
      data: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${salt}</dc:title></metadata><manifest><item id="a" href="Text/one.xhtml" media-type="application/xhtml+xml"/><item id="b" href="Text/two%20b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>`,
    },
    { name: "OEBPS/Text/one.xhtml", data: xhtml(`<h1>One</h1><p>a ${salt}</p><p>b</p>`) },
    { name: "OEBPS/Text/two b.xhtml", data: xhtml(`<div class="x"><h2>Two</h2><p>first</p><p>second</p><p>third &amp; last</p></div><p>after</p>`) },
  ]);
}

let f: Family;
let booksDir: string;
let configDir: string;
let ids: Record<string, string>;
let files: Record<string, { id: string; abs: string }>;

async function addFile(bookId: string, rel: string, data: Buffer, format: "epub" | "pdf" = "epub") {
  const abs = join(booksDir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, data);
  const [row] = f.db.insert(bookFiles).values({ bookId, relPath: rel, format, sizeBytes: data.length }).returning().all();
  return { id: row!.id, abs };
}

beforeEach(async () => {
  booksDir = await tempDir();
  configDir = await tempDir();
  f = await family(
    { ereader: { kepub: new KepubConverter(join(configDir, "no-kepubify"), join(configDir, "cache")) } },
    { BOOKS_DIR: booksDir, CONFIG_DIR: configDir, LIBRARY_SCAN_ON_START: "false" },
  );
  await mkdir(join(configDir, "covers"), { recursive: true });
  await writeFile(join(configDir, "covers", "kid.png"), PNG);
  await writeFile(join(configDir, "covers", "adult.png"), PNG);
  ids = {
    kidBook: f.book("Dragon Picnic", "kids", { coverPath: "covers/kid.png", description: "A picnic." }),
    kidBook2: f.book("Dragon Picnic 2", "kids"),
    adultBook: f.book("Midnight Affairs", "adult", { coverPath: "covers/adult.png" }),
    unrated: f.book("Mystery Box", null),
    inbox: f.book("Inbox Thing", "kids", { approved: false }),
    kindle: f.book("Kindle Only", "kids", { kindleOnly: true }),
  };
  const [kidAuthor] = f.db.insert(authors).values({ name: "Pat Kid", sortName: "Kid, Pat" }).returning().all();
  const [adultAuthor] = f.db.insert(authors).values({ name: "Sam Steamy", sortName: "Steamy, Sam" }).returning().all();
  ids.kidAuthor = kidAuthor!.id;
  ids.adultAuthor = adultAuthor!.id;
  f.db.insert(bookAuthors).values([
    { bookId: ids.kidBook, authorId: kidAuthor!.id },
    { bookId: ids.kidBook2, authorId: kidAuthor!.id },
    { bookId: ids.adultBook, authorId: adultAuthor!.id },
  ]).run();
  const [dragons] = f.db.insert(series).values({ name: "Dragons" }).returning().all();
  ids.series = dragons!.id;
  f.db.insert(bookSeries).values([
    { bookId: ids.kidBook2, seriesId: dragons!.id, position: 2 },
    { bookId: ids.kidBook, seriesId: dragons!.id, position: 1 },
  ]).run();
  f.db.insert(kidShelf).values({ kidId: f.ids.kid, bookId: ids.kidBook }).run();

  files = {
    kid: await addFile(ids.kidBook, "kids/dragon.epub", await twoChapterEpub("kid")),
    kid2: await addFile(ids.kidBook2, "kids/dragon2.epub", await twoChapterEpub("kid2")),
    adult: await addFile(ids.adultBook, "adult/midnight.epub", await twoChapterEpub("adult")),
    unrated: await addFile(ids.unrated, "misc/box.epub", await twoChapterEpub("box")),
    inbox: await addFile(ids.inbox, "inbox/thing.epub", await twoChapterEpub("inbox")),
  };
});

afterEach(async () => {
  await f.close();
});

type Who = "admin" | "parent" | "adult" | "kid";

async function createLogin(by: Who, userId?: string) {
  const res = await f.app.inject({
    method: "POST",
    url: "/api/ereader/credentials",
    headers: f.as(by),
    payload: { kind: "login", name: "KOReader", ...(userId ? { userId } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { username: string; password: string; credential: { id: string } };
}

async function createKobo(by: Who, userId?: string) {
  const res = await f.app.inject({
    method: "POST",
    url: "/api/ereader/credentials",
    headers: f.as(by),
    payload: { kind: "kobo", name: "Clara", ...(userId ? { userId } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { token: string; koboApiEndpoint: string; credential: { id: string } };
}

const basic = (u: string, p: string) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}` });

// ---------------------------------------------------------------------------

describe("e-reader sign-ins", () => {
  it("lets adults make their own and parents make their kids'", async () => {
    const own = await createLogin("adult");
    expect(own.password).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    expect(own.username).toMatch(/^aunt-/);

    const forKid = await createLogin("parent", f.ids.kid);
    const list = await f.app.inject({ url: "/api/ereader/credentials", headers: f.as("parent") });
    expect(list.json().credentials.map((c: { id: string }) => c.id)).toContain(forKid.credential.id);
    expect(JSON.stringify(list.json())).not.toContain(forKid.password);

    const kobo = await createKobo("parent", f.ids.kid);
    expect(kobo.koboApiEndpoint).toBe(`http://localhost:80/kobo/${kobo.token}`);
  });

  it("never lets a kid create or revoke one, and parents only manage their own kids", async () => {
    const kidTry = await f.app.inject({
      method: "POST",
      url: "/api/ereader/credentials",
      headers: f.as("kid"),
      payload: { kind: "login", name: "mine" },
    });
    expect(kidTry.statusCode).toBe(403);

    const otherKid = await f.app.inject({
      method: "POST",
      url: "/api/ereader/credentials",
      headers: f.as("parent"),
      payload: { kind: "login", name: "x", userId: f.ids.otherKid },
    });
    expect([403, 404]).toContain(otherKid.statusCode);

    const adultsOwn = await createLogin("adult");
    const parentDeletes = await f.app.inject({
      method: "DELETE",
      url: `/api/ereader/credentials/${adultsOwn.credential.id}`,
      headers: f.as("parent"),
    });
    expect(parentDeletes.statusCode).toBe(404);

    const kids = await createLogin("parent", f.ids.kid);
    const kidDeletes = await f.app.inject({ method: "DELETE", url: `/api/ereader/credentials/${kids.credential.id}`, headers: f.as("kid") });
    expect(kidDeletes.statusCode).toBe(403);
  });

  it("stops working once revoked", async () => {
    const c = await createLogin("adult");
    expect((await f.app.inject({ url: "/opds", headers: basic(c.username, c.password) })).statusCode).toBe(200);
    await f.app.inject({ method: "DELETE", url: `/api/ereader/credentials/${c.credential.id}`, headers: f.as("adult") });
    expect((await f.app.inject({ url: "/opds", headers: basic(c.username, c.password) })).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------

describe("OPDS", () => {
  it("asks for Basic auth and rejects a wrong password", async () => {
    const none = await f.app.inject({ url: "/opds" });
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toMatch(/^Basic realm="Bookbandit"/);
    const c = await createLogin("adult");
    expect((await f.app.inject({ url: "/opds", headers: basic(c.username, "nope") })).statusCode).toBe(401);
    const ok = await f.app.inject({ url: "/opds", headers: basic(c.username.toUpperCase(), c.password) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("kind=navigation");
    expect(ok.body).toContain('href="/opds/series"');
  });

  it("also works with the browser's own sign-in", async () => {
    const res = await f.app.inject({ url: "/opds/books", headers: f.as("adult") });
    expect(res.statusCode).toBe(200);
  });

  it("lists only books the kid may see, with downloads and covers", async () => {
    const c = await createLogin("parent", f.ids.kid);
    const auth = basic(c.username, c.password);
    const all = await f.app.inject({ url: "/opds/books", headers: auth });
    expect(all.statusCode).toBe(200);
    expect(all.body).toContain("Dragon Picnic");
    expect(all.body).not.toContain("Midnight Affairs");
    expect(all.body).not.toContain("Mystery Box"); // unrated counts as adult
    expect(all.body).not.toContain("Inbox Thing");
    expect(all.body).not.toContain("Kindle Only"); // nothing to download
    expect(all.body).toContain(`/opds/books/${ids.kidBook}/files/${files.kid!.id}`);
    expect(all.body).toContain(`<opensearch:totalResults>2</opensearch:totalResults>`);

    const dl = await f.app.inject({ url: `/opds/books/${ids.kidBook}/files/${files.kid!.id}`, headers: auth });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(dl.rawPayload.equals(await readFile(files.kid!.abs))).toBe(true);

    expect((await f.app.inject({ url: `/opds/books/${ids.kidBook}/cover`, headers: auth })).statusCode).toBe(200);
  });

  it("returns 404 for locked books, covers and adult-only authors", async () => {
    const c = await createLogin("parent", f.ids.kid);
    const auth = basic(c.username, c.password);
    const urls = [
      `/opds/books/${ids.adultBook}/files/${files.adult!.id}`,
      `/opds/books/${ids.adultBook}/cover`,
      `/opds/books/${ids.unrated}/files/${files.unrated!.id}`,
      `/opds/books/${ids.inbox}/files/${files.inbox!.id}`,
      `/opds/authors/${ids.adultAuthor}`,
      // A file id from another book never works, even if both are visible.
      `/opds/books/${ids.kidBook}/files/${files.kid2!.id}`,
    ];
    for (const url of urls) expect((await f.app.inject({ url, headers: auth })).statusCode, url).toBe(404);

    const authorsFeed = await f.app.inject({ url: "/opds/authors", headers: auth });
    expect(authorsFeed.body).toContain("Pat Kid");
    expect(authorsFeed.body).not.toContain("Sam Steamy");

    const search = await f.app.inject({ url: "/opds/search?q=midnight", headers: auth });
    expect(search.body).not.toContain("Midnight Affairs");
    const searchAuthor = await f.app.inject({ url: "/opds/search?q=steamy", headers: auth });
    expect(searchAuthor.body).toContain("<opensearch:totalResults>0</opensearch:totalResults>");
  });

  it("shows an adult everything they opted into", async () => {
    const c = await createLogin("adult");
    const res = await f.app.inject({ url: "/opds/search?q=midnight", headers: basic(c.username, c.password) });
    expect(res.body).toContain("Midnight Affairs");
  });

  it("orders a series by position and pages long lists", async () => {
    const c = await createLogin("adult");
    const auth = basic(c.username, c.password);
    const s = await f.app.inject({ url: `/opds/series/${ids.series}`, headers: auth });
    expect(s.body.indexOf("Dragon Picnic</title>")).toBeLessThan(s.body.indexOf("Dragon Picnic 2</title>"));

    for (let i = 0; i < 55; i++) {
      const id = f.book(`Filler ${String(i).padStart(2, "0")}`, "kids");
      f.db.insert(bookFiles).values({ bookId: id, relPath: `filler/${i}.epub`, format: "epub", sizeBytes: 1 }).run();
    }
    const p1 = await f.app.inject({ url: "/opds/books", headers: auth });
    expect(p1.body).toContain('rel="next" href="/opds/books?page=2"');
    const p2 = await f.app.inject({ url: "/opds/books?page=2", headers: auth });
    expect(p2.body).toContain('rel="previous" href="/opds/books"');
    expect(p2.body).not.toContain('rel="next"');
  });

  it("shows the kid's shelf and continue reading", async () => {
    const c = await createLogin("parent", f.ids.kid);
    const auth = basic(c.username, c.password);
    expect((await f.app.inject({ url: "/opds", headers: auth })).body).toContain("/opds/kid");
    const shelf = await f.app.inject({ url: "/opds/kid", headers: auth });
    expect(shelf.body).toContain("Dragon Picnic</title>");
    expect(shelf.body).not.toContain("Dragon Picnic 2");
  });
});

// ---------------------------------------------------------------------------

describe("KOReader position translation", () => {
  it("computes KOReader's partial MD5", async () => {
    const dir = await tempDir();
    const small = join(dir, "small.bin");
    await writeFile(small, "hello");
    expect(await partialMd5(small)).toBe(md5("hello"));

    const big = Buffer.alloc(70_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
    await writeFile(join(dir, "big.bin"), big);
    const h = createHash("md5");
    for (const off of [0, 1024, 4096, 16384, 65536]) h.update(big.subarray(off, off + 1024));
    expect(await partialMd5(join(dir, "big.bin"))).toBe(h.digest("hex"));
  });

  it("maps XPointers to CFIs and back at paragraph level", async () => {
    const abs = files.kid!.abs;
    const cfi = await xpointerToCfi(abs, "/body/DocFragment[2]/body/div/p[3]/text().0");
    expect(cfi).toBe("epubcfi(/6/4!/4/2/8)");
    expect(await cfiToXpointer(abs, "epubcfi(/6/4[b]!/4/2[x]/8/1:5)")).toBe("/body/DocFragment[2]/body/div/p[3]");
    expect(await cfiToXpointer(abs, "epubcfi(/6/2!/4/4/1:0)")).toBe("/body/DocFragment[1]/body/p[1]");
    // Paths that don't exist fall back to the deepest element that does.
    expect(await xpointerToCfi(abs, "/body/DocFragment[1]/body/table[4]/tr")).toBe("epubcfi(/6/2!/4)");
    expect(await xpointerToCfi(abs, "/body/DocFragment[9]/body")).toBeNull();
    expect(parseCfi("epubcfi(/6/4!/4/2,/1:0,/3:4)")).toEqual({ spineIndex: 1, steps: [4, 2] });
  });
});

describe("KOReader sync", () => {
  async function kosync(c: { username: string; password: string }) {
    const headers = { "x-auth-user": c.username, "x-auth-key": md5(c.password), accept: "application/vnd.koreader.v1+json" };
    return {
      auth: () => f.app.inject({ url: "/kosync/users/auth", headers }),
      put: (payload: object) => f.app.inject({ method: "PUT", url: "/kosync/syncs/progress", headers, payload }),
      get: (doc: string) => f.app.inject({ url: `/kosync/syncs/progress/${doc}`, headers }),
    };
  }

  it("authorizes e-reader logins and turns sign-ups away", async () => {
    const c = await createLogin("adult");
    expect((await (await kosync(c)).auth()).json()).toEqual({ authorized: "OK" });
    expect((await (await kosync({ ...c, password: "wrong" })).auth()).statusCode).toBe(401);
    const signup = await f.app.inject({ method: "POST", url: "/kosync/users/create", payload: { username: "x", password: "y" } });
    expect(signup.statusCode).toBe(402);
  });

  it("syncs a library book both ways with the web reader", async () => {
    const c = await createLogin("parent", f.ids.kid);
    const k = await kosync(c);
    const doc = await partialMd5(files.kid!.abs);

    const put = await k.put({ document: doc, progress: "/body/DocFragment[2]/body/div/p[3]/text().12", percentage: 0.62, device: "Kobo Libra", device_id: "dev1" });
    expect(put.statusCode).toBe(200);
    expect(put.json().document).toBe(doc);

    const rp = f.db
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, f.ids.kid), eq(readingProgress.bookId, ids.kidBook)))
      .get();
    expect(rp?.locator).toEqual({ kind: "epub", cfi: "epubcfi(/6/4!/4/2/8)", percent: 0.62 });
    expect(rp?.deviceName).toBe("KOReader (Kobo Libra)");

    // KOReader gets its own record back while it's the newest.
    expect((await k.get(doc)).json()).toMatchObject({ progress: "/body/DocFragment[2]/body/div/p[3]/text().12", device_id: "dev1" });

    // The web reader moves on; KOReader now gets that position as an XPointer.
    const web = await f.app.inject({
      method: "PUT",
      url: `/api/progress/${ids.kidBook}`,
      headers: f.as("kid"),
      payload: { locator: { kind: "epub", cfi: "epubcfi(/6/4!/4/4/1:0)", percent: 0.9 }, updatedAt: Date.now() + 5, deviceName: "Web" },
    });
    expect(web.statusCode).toBe(200);
    expect(web.json().status).toBe("applied");
    const back = (await k.get(doc)).json();
    expect(back).toMatchObject({ progress: "/body/DocFragment[2]/body/p", percentage: 0.9, device: "Web", device_id: "bookbandit" });
  });

  it("matches by file name too, and keeps books that aren't in the library", async () => {
    const c = await createLogin("adult");
    const k = await kosync(c);
    await k.put({ document: md5("dragon.epub"), progress: "/body/DocFragment[1]/body/p[2]", percentage: 0.1, device: "KOReader" });
    const rp = f.db.select().from(readingProgress).where(eq(readingProgress.bookId, ids.kidBook)).get();
    expect(rp?.userId).toBe(f.ids.adult);

    const stranger = "0123456789abcdef0123456789abcdef";
    expect((await k.get(stranger)).json()).toEqual({});
    await k.put({ document: stranger, progress: "42", percentage: 0.5, device: "KOReader", device_id: "d" });
    expect((await k.get(stranger)).json()).toMatchObject({ document: stranger, progress: "42", percentage: 0.5 });
  });

  it("syncs PDF pages, counting from 1 in KOReader and from 0 in the web reader", async () => {
    const pdfBook = f.book("Picture Atlas", "kids");
    const pdf = await addFile(pdfBook, "kids/atlas.pdf", Buffer.from("%PDF-1.4 atlas"), "pdf");
    const c = await createLogin("adult");
    const k = await kosync(c);
    const doc = await partialMd5(pdf.abs);
    await k.put({ document: doc, progress: "5", percentage: 0.5, device: "KOReader" });
    const rp = f.db.select().from(readingProgress).where(eq(readingProgress.bookId, pdfBook)).get();
    expect(rp?.locator).toEqual({ kind: "page", page: 4, totalPages: 10 });

    await f.app.inject({
      method: "PUT",
      url: `/api/progress/${pdfBook}`,
      headers: f.as("adult"),
      payload: { locator: { kind: "page", page: 7, totalPages: 10 }, updatedAt: Date.now() + 5, deviceName: "Web" },
    });
    expect((await k.get(doc)).json()).toMatchObject({ progress: "8", percentage: 0.7 });
  });

  it("treats a locked book exactly like an unknown file", async () => {
    const c = await createLogin("parent", f.ids.kid);
    const k = await kosync(c);
    const adultDoc = await partialMd5(files.adult!.abs);
    // Someone else's position in the adult book must never leak to the kid.
    f.db.insert(readingProgress).values({
      userId: f.ids.kid,
      bookId: ids.adultBook,
      locator: { kind: "epub", cfi: "epubcfi(/6/2!/4)", percent: 0.3 },
      percent: 0.3,
      clientUpdatedAt: Date.now() - 1000,
      serverUpdatedAt: Date.now() - 1000,
    }).run();
    expect((await k.get(adultDoc)).json()).toEqual({});

    await k.put({ document: adultDoc, progress: "/body/DocFragment[2]/body/p", percentage: 0.8, device: "KOReader" });
    const rp = f.db
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, f.ids.kid), eq(readingProgress.bookId, ids.adultBook)))
      .get();
    expect(rp?.percent).toBe(0.3); // untouched
  });
});

// ---------------------------------------------------------------------------

describe("Kobo sync", () => {
  async function kobo(by: Who, userId?: string) {
    const k = await createKobo(by, userId);
    const base = `/kobo/${k.token}`;
    return {
      ...k,
      base,
      sync: (token?: string) =>
        f.app.inject({ url: `${base}/v1/library/sync`, headers: token ? { "x-kobo-synctoken": token } : {} }),
    };
  }

  const entitlementIds = (body: unknown[]) =>
    body.map((r) => {
      const e = r as Record<string, { BookEntitlement?: { Id: string; IsRemoved: boolean }; ReadingState?: { EntitlementId: string } }>;
      const kind = Object.keys(e)[0]!;
      const inner = e[kind]!;
      return `${kind}:${inner.BookEntitlement?.Id ?? inner.ReadingState?.EntitlementId}${inner.BookEntitlement?.IsRemoved ? ":removed" : ""}`;
    });

  it("rejects a bad token", async () => {
    expect((await f.app.inject({ url: "/kobo/bbk_nope/v1/library/sync" })).statusCode).toBe(401);
    expect((await f.app.inject({ url: "/kobo/bbk_nope/v1/initialization" })).statusCode).toBe(401);
  });

  it("points the Kobo's resources back at Bookbandit", async () => {
    const k = await kobo("adult");
    const res = await f.app.inject({ url: `${k.base}/v1/initialization` });
    expect(res.statusCode).toBe(200);
    const r = res.json().Resources;
    expect(r.library_sync).toBe(`http://localhost:80${k.base}/v1/library/sync`);
    expect(r.image_url_quality_template).toContain(`${k.base}/covers/{ImageId}`);
    expect(JSON.stringify(r)).not.toContain("storeapi.kobo.com");
  });

  it("syncs the kid's books only, then just the changes, and removes books that get locked", async () => {
    const k = await kobo("parent", f.ids.kid);
    const first = await k.sync();
    expect(first.statusCode).toBe(200);
    expect(entitlementIds(first.json()).sort()).toEqual([`NewEntitlement:${ids.kidBook}`, `NewEntitlement:${ids.kidBook2}`].sort());
    const meta = first.json()[0].NewEntitlement.BookMetadata;
    expect(meta.DownloadUrls[0].Format).toBe("EPUB"); // no kepubify in tests
    expect(meta.DownloadUrls[0].Url).toMatch(new RegExp(`${k.base}/download/[0-9a-f-]+/epub$`));
    const token = first.headers["x-kobo-synctoken"] as string;
    expect(decodeSyncToken(token)).not.toBeNull();

    expect((await k.sync(token)).json()).toEqual([]);

    // A parent re-rates a book out of the kid's reach: it comes off the Kobo.
    f.db.update(books).set({ rating: "adult", updatedAt: Date.now() }).where(eq(books.id, ids.kidBook2)).run();
    const third = await k.sync(token);
    expect(entitlementIds(third.json())).toEqual([`ChangedEntitlement:${ids.kidBook2}:removed`]);
    expect(JSON.stringify(third.json())).not.toContain("BookMetadata");

    // And its download, metadata, cover and state are 404 now.
    for (const url of [
      `${k.base}/download/${ids.kidBook2}/epub`,
      `${k.base}/v1/library/${ids.kidBook2}/metadata`,
      `${k.base}/v1/library/${ids.kidBook2}/state`,
      `${k.base}/covers/${ids.adultBook}/100/150/false/image.jpg`,
    ]) {
      expect((await f.app.inject({ url })).statusCode, url).toBe(404);
    }
  });

  it("sends changed metadata again and respects removal on the device", async () => {
    const k = await kobo("adult");
    const token = (await k.sync()).headers["x-kobo-synctoken"] as string;
    f.db.update(books).set({ title: "Dragon Picnic (revised)", updatedAt: Date.now() + 10 }).where(eq(books.id, ids.kidBook)).run();
    const changed = await k.sync(token);
    expect(entitlementIds(changed.json())).toEqual([`ChangedEntitlement:${ids.kidBook}`]);

    const del = await f.app.inject({ method: "DELETE", url: `${k.base}/v1/library/${ids.kidBook}` });
    expect(del.statusCode).toBe(204);
    f.db.update(books).set({ updatedAt: Date.now() + 20 }).where(eq(books.id, ids.kidBook)).run();
    expect((await k.sync(token)).json()).toEqual([]);
  });

  it("downloads the EPUB when kepubify isn't available", async () => {
    const k = await kobo("adult");
    const res = await f.app.inject({ url: `${k.base}/download/${ids.kidBook}/kepub` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(await readFile(files.kid!.abs))).toBe(true);
    expect((await f.app.inject({ url: `${k.base}/covers/${ids.kidBook}/100/150/80/false/image.jpg` })).statusCode).toBe(200);
  });

  it("syncs reading state both ways", async () => {
    const k = await kobo("parent", f.ids.kid);
    const token = (await k.sync()).headers["x-kobo-synctoken"] as string;
    const lm = new Date(Date.now() - 1000).toISOString();
    const put = await f.app.inject({
      method: "PUT",
      url: `${k.base}/v1/library/${ids.kidBook}/state`,
      payload: {
        ReadingStates: [
          {
            EntitlementId: ids.kidBook,
            CurrentBookmark: {
              LastModified: lm,
              ProgressPercent: 55,
              ContentSourceProgressPercent: 10,
              Location: { Value: "kobo.3.1", Type: "KoboSpan", Source: "Text/two b.xhtml" },
            },
            StatusInfo: { LastModified: lm, Status: "Reading" },
          },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().RequestResult).toBe("Success");
    const rp = f.db
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, f.ids.kid), eq(readingProgress.bookId, ids.kidBook)))
      .get();
    expect(rp?.locator).toEqual({ kind: "epub", cfi: "epubcfi(/6/4!/4)", percent: 0.55 });
    expect(rp?.deviceName).toBe("Kobo (Clara)");

    // The Kobo gets its exact bookmark back while it's the newest.
    const state = (await f.app.inject({ url: `${k.base}/v1/library/${ids.kidBook}/state` })).json()[0];
    expect(state.CurrentBookmark.Location.Value).toBe("kobo.3.1");
    expect(state.StatusInfo.Status).toBe("Reading");

    // The web reader moves to chapter 1; the next sync carries it as a changed reading state.
    await f.app.inject({
      method: "PUT",
      url: `/api/progress/${ids.kidBook}`,
      headers: f.as("kid"),
      payload: { locator: { kind: "epub", cfi: "epubcfi(/6/2!/4/4)", percent: 0.7 }, updatedAt: Date.now(), deviceName: "Web" },
    });
    const next = (await k.sync(token)).json();
    expect(entitlementIds(next)).toEqual([`ChangedReadingState:${ids.kidBook}`]);
    const moved = next[0].ChangedReadingState.ReadingState;
    expect(moved.CurrentBookmark).toMatchObject({ ProgressPercent: 70, Location: { Source: "OEBPS/Text/one.xhtml", Type: "KoboSpan" } });
  });

  it("won't take reading state for a locked book", async () => {
    const k = await kobo("parent", f.ids.kid);
    const res = await f.app.inject({
      method: "PUT",
      url: `${k.base}/v1/library/${ids.adultBook}/state`,
      payload: { ReadingStates: [{ CurrentBookmark: { ProgressPercent: 10 } }] },
    });
    expect(res.statusCode).toBe(404);
  });

  it("answers other store calls with empty results", async () => {
    const k = await kobo("adult");
    const res = await f.app.inject({ url: `${k.base}/v1/products/featured` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    const auth = await f.app.inject({ method: "POST", url: `${k.base}/v1/auth/device`, payload: { UserKey: "abc" } });
    expect(auth.json()).toMatchObject({ TokenType: "Bearer", UserKey: "abc" });
  });
});
