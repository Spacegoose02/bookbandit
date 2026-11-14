import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildApp } from "../../src/app.js";
import { openDb, type Db } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { bookFiles, books, households, userIdentities, users } from "../../src/db/schema.js";
import { parseRange } from "../../src/library/serve.js";
import { isDrmProtected } from "../../src/library/drm.js";
import { makeEpub, PNG, tempDir } from "./fixtures.js";
import yazl from "yazl";

let app: FastifyInstance;
let db: Db;
let close: () => void;
let booksDir: string;
let configDir: string;
const ids: Record<string, { book: string; file: string }> = {};

const kidBirthYear = new Date().getUTCFullYear() - 8;

async function addBook(title: string, rating: "kids" | "adult" | null, approved: boolean, relPath: string, content: Buffer) {
  await mkdir(join(booksDir, relPath, ".."), { recursive: true });
  await writeFile(join(booksDir, relPath), content);
  const [b] = db.insert(books).values({ title, sortTitle: title.toLowerCase(), rating, approved, coverPath: `covers/${title}.png` }).returning().all();
  await writeFile(join(configDir, `covers/${title}.png`), PNG);
  const [f] = db
    .insert(bookFiles)
    .values({ bookId: b!.id, relPath, format: relPath.endsWith(".pdf") ? "pdf" : relPath.endsWith(".azw3") ? "azw3" : "epub", sizeBytes: content.length })
    .returning()
    .all();
  ids[title] = { book: b!.id, file: f!.id };
}

beforeEach(async () => {
  ({ db, close } = openDb(":memory:"));
  booksDir = await tempDir("bb-books-");
  configDir = await tempDir("bb-config-");
  await mkdir(join(configDir, "covers"));
  const [home] = db.insert(households).values({ name: "Home" }).returning().all();
  const people = db
    .insert(users)
    .values([
      { householdId: home!.id, displayName: "Dad", role: "parent" },
      { householdId: home!.id, displayName: "Emma", role: "kid", birthYear: kidBirthYear, kidSignInMethod: "google" },
    ])
    .returning()
    .all();
  db.insert(userIdentities)
    .values(people.map((p) => ({ userId: p.id, provider: "tinyauth" as const, subject: `${p.displayName.toLowerCase()}@example.com` })))
    .run();

  const pdf = Buffer.from("%PDF-1.4\n" + "x".repeat(1000));
  await addBook("Picture", "kids", true, "kids/Picture.pdf", pdf);
  await addBook("Thriller", "adult", true, "Thriller.pdf", pdf);
  await addBook("Inbox", "kids", false, "Inbox.pdf", pdf);

  const config = loadConfig({
    TRUSTED_PROXIES: "127.0.0.1",
    LOG_LEVEL: "error",
    BOOKS_DIR: booksDir,
    CONFIG_DIR: configDir,
    METADATA_ONLINE: "false",
  } as NodeJS.ProcessEnv);
  app = await buildApp(config, db);
});

afterEach(async () => {
  await app.close();
  close();
});

const get = (who: string, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers: { "remote-email": `${who}@example.com`, ...headers } });

describe("cover and file serving", () => {
  it("serves a cover the reader can see", async () => {
    const res = await get("emma", `/api/books/${ids.Picture!.book}/cover`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it("returns 404 for covers and files of locked or inbox books", async () => {
    for (const t of ["Thriller", "Inbox"]) {
      expect((await get("emma", `/api/books/${ids[t]!.book}/cover`)).statusCode).toBe(404);
      expect((await get("emma", `/api/books/${ids[t]!.book}/files/${ids[t]!.file}`)).statusCode).toBe(404);
    }
    expect((await get("dad", `/api/books/${ids.Inbox!.book}/files/${ids.Inbox!.file}`)).statusCode).toBe(404);
    expect((await get("dad", `/api/books/${ids.Thriller!.book}/files/${ids.Thriller!.file}`)).statusCode).toBe(200);
  });

  it("requires sign-in", async () => {
    const res = await app.inject({ method: "GET", url: `/api/books/${ids.Picture!.book}/cover` });
    expect(res.statusCode).toBe(401);
  });

  it("won't serve a file through another book's id", async () => {
    const res = await get("dad", `/api/books/${ids.Picture!.book}/files/${ids.Thriller!.file}`);
    expect(res.statusCode).toBe(404);
  });

  it("serves the whole file with type, length and accept-ranges", async () => {
    const res = await get("emma", `/api/books/${ids.Picture!.book}/files/${ids.Picture!.file}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe("1009");
    expect(res.headers["content-disposition"]).toContain("Picture.pdf");
  });

  it("supports Range requests", async () => {
    const url = `/api/books/${ids.Picture!.book}/files/${ids.Picture!.file}`;
    const part = await get("emma", url, { range: "bytes=0-7" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe("bytes 0-7/1009");
    expect(part.payload).toBe("%PDF-1.4");
    const tail = await get("emma", url, { range: "bytes=-3" });
    expect(tail.statusCode).toBe(206);
    expect(tail.payload).toBe("xxx");
    expect((await get("emma", url, { range: "bytes=5000-" })).statusCode).toBe(416);
  });

  it("parses ranges", () => {
    expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange("bytes=10-500", 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange("bytes=0-1,5-6", 100)).toBeUndefined();
    expect(parseRange("bytes=50-10", 100)).toBe("invalid");
  });

  it("refuses DRM-protected Kindle and Adobe files", async () => {
    // A MOBI whose PalmDOC header says encryption type 2 (Kindle DRM).
    const mobi = Buffer.alloc(200);
    mobi.writeUInt32BE(100, 78);
    mobi.writeUInt16BE(2, 100 + 12);
    await addBook("Locked Kindle", null, true, "Locked.azw3", mobi);
    const res = await get("dad", `/api/books/${ids["Locked Kindle"]!.book}/files/${ids["Locked Kindle"]!.file}`);
    expect(res.statusCode).toBe(409);

    const clean = Buffer.from(mobi);
    clean.writeUInt16BE(0, 100 + 12);
    await writeFile(join(booksDir, "Clean.azw3"), clean);
    expect(await isDrmProtected(join(booksDir, "Clean.azw3"), "azw3")).toBe(false);

    const epub = join(booksDir, "plain.epub");
    await makeEpub(epub, { title: "Plain" });
    expect(await isDrmProtected(epub, "epub")).toBe(false);

    const adept = join(booksDir, "adept.epub");
    await zip(adept, {
      "META-INF/encryption.xml": `<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>`,
    });
    expect(await isDrmProtected(adept, "epub")).toBe(true);
    const fonts = join(booksDir, "fonts.epub");
    await zip(fonts, {
      "META-INF/encryption.xml": `<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></EncryptedData></encryption>`,
    });
    expect(await isDrmProtected(fonts, "epub")).toBe(false);
  });
});

function zip(path: string, entries: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const [name, data] of Object.entries(entries)) z.addBuffer(Buffer.from(data), name);
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on("data", (c: Buffer) => chunks.push(c));
    z.outputStream.on("end", () => writeFile(path, Buffer.concat(chunks)).then(resolve, reject));
  });
}
