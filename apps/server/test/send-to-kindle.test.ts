import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookFiles, settings } from "../src/db/schema.js";
import { family, type Family } from "./helpers.js";
import type { OutgoingMail } from "../src/integrations/kindle/mailer.js";
import { safeFilename } from "../src/integrations/kindle/routes.js";
import { secretBox } from "../src/integrations/secrets.js";

let f: Family;
let dir: string;
const sent: OutgoingMail[] = [];

beforeEach(async () => {
  sent.length = 0;
  dir = mkdtempSync(join(tmpdir(), "bb-books-"));
  f = await family(
    {
      integrations: {
        makeMailer: () => ({
          send: async (m) => void sent.push(m),
          verify: async () => {},
        }),
      },
    },
    { BOOKS_DIR: dir },
  );
});
afterEach(async () => {
  await f.close();
  rmSync(dir, { recursive: true, force: true });
});

const setSmtp = () =>
  f.app.inject({
    method: "PUT",
    url: "/api/admin/integrations/smtp",
    headers: f.as("admin"),
    payload: { host: "smtp.example.com", port: 587, user: "me", password: "hunter2", from: "books@example.com" },
  });

function fileFor(bookId: string, rel: string, format: "epub" | "pdf", bytes = 10) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), Buffer.alloc(bytes, 1));
  f.db.insert(bookFiles).values({ bookId, relPath: rel, format, sizeBytes: bytes }).run();
}

const setAddress = (who: Parameters<Family["as"]>[0], userId: string, email: string) =>
  f.app.inject({ method: "PUT", url: `/api/kindle/addresses/${userId}`, headers: f.as(who), payload: { email } });

describe("kindle addresses", () => {
  it("only lets a parent or admin set a kid's address", async () => {
    expect((await setAddress("kid", f.ids.kid, "emma@kindle.com")).statusCode).toBe(403);
    expect((await setAddress("adult", f.ids.kid, "emma@kindle.com")).statusCode).toBe(403);
    // A parent not linked to this kid can't either.
    expect((await setAddress("parent", f.ids.otherKid, "leo@kindle.com")).statusCode).toBe(403);
    expect((await setAddress("parent", f.ids.kid, "Emma@Kindle.com")).statusCode).toBe(200);
    expect((await setAddress("admin", f.ids.otherKid, "leo@kindle.com")).statusCode).toBe(200);
    const me = await f.app.inject({ url: "/api/kindle/me", headers: f.as("kid") });
    expect(me.json()).toMatchObject({ email: "emma@kindle.com", canEdit: false });
  });

  it("lets adults set only their own, and only Kindle domains", async () => {
    expect((await setAddress("adult", f.ids.adult, "aunt@gmail.com")).statusCode).toBe(400);
    expect((await setAddress("adult", f.ids.parent, "dad@kindle.com")).statusCode).toBe(403);
    expect((await setAddress("adult", f.ids.adult, "aunt_42@free.kindle.com")).statusCode).toBe(200);
  });
});

describe("send to kindle", () => {
  it("sends the EPUB of a visible book to the reader's own address", async () => {
    await setSmtp();
    const id = f.book("Charlotte's Web: A Story", "kids");
    fileFor(id, "kids/charlotte.pdf", "pdf");
    fileFor(id, "kids/charlotte.epub", "epub");
    await setAddress("parent", f.ids.kid, "emma@kindle.com");

    const res = await f.app.inject({ method: "POST", url: `/api/books/${id}/send-to-kindle`, headers: f.as("kid") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sentTo: "emma@kindle.com", filename: "Charlotte's Web A Story.epub", format: "epub" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("emma@kindle.com");
    expect(sent[0]!.attachments![0]!.path).toBe(join(dir, "kids/charlotte.epub"));

    const pdf = await f.app.inject({
      method: "POST",
      url: `/api/books/${id}/send-to-kindle`,
      headers: f.as("kid"),
      payload: { format: "pdf" },
    });
    expect(pdf.json().format).toBe("pdf");
  });

  it("returns 404 for a book above the kid's limit", async () => {
    await setSmtp();
    const id = f.book("Thriller", "adult");
    fileFor(id, "adult/thriller.epub", "epub");
    await setAddress("parent", f.ids.kid, "emma@kindle.com");
    const res = await f.app.inject({ method: "POST", url: `/api/books/${id}/send-to-kindle`, headers: f.as("kid") });
    expect(res.statusCode).toBe(404);
    expect(sent).toHaveLength(0);
  });

  it("explains what's missing", async () => {
    const id = f.book("Novel", "adult");
    const noSmtp = await f.app.inject({ method: "POST", url: `/api/books/${id}/send-to-kindle`, headers: f.as("adult") });
    expect(noSmtp.statusCode).toBe(503);
    await setSmtp();
    const noAddress = await f.app.inject({ method: "POST", url: `/api/books/${id}/send-to-kindle`, headers: f.as("adult") });
    expect(noAddress.statusCode).toBe(409);
    await setAddress("adult", f.ids.adult, "aunt@kindle.com");
    const noFile = await f.app.inject({ method: "POST", url: `/api/books/${id}/send-to-kindle`, headers: f.as("adult") });
    expect(noFile.statusCode).toBe(422);
  });

  it("refuses files that escape the books folder", async () => {
    await setSmtp();
    await setAddress("adult", f.ids.adult, "aunt@kindle.com");
    const id = f.book("Sneaky", "adult");
    f.db.insert(bookFiles).values({ bookId: id, relPath: "../../etc/passwd.epub", format: "epub", sizeBytes: 1 }).run();
    const res = await f.app.inject({ method: "POST", url: `/api/books/${id}/send-to-kindle`, headers: f.as("adult") });
    expect(res.statusCode).toBe(422);
    expect(sent).toHaveLength(0);
  });
});

describe("smtp settings", () => {
  it("are admin-only and keep the password sealed", async () => {
    const denied = await f.app.inject({
      method: "PUT",
      url: "/api/admin/integrations/smtp",
      headers: f.as("parent"),
      payload: { host: "h", from: "a@b.co" },
    });
    expect(denied.statusCode).toBe(403);
    const res = await setSmtp();
    expect(res.json()).toMatchObject({ configured: true, hasPassword: true });
    expect(res.body).not.toContain("hunter2");
    expect(JSON.stringify(f.db.select().from(settings).all())).not.toContain("hunter2");
    const test = await f.app.inject({
      method: "POST",
      url: "/api/admin/integrations/smtp/test",
      headers: f.as("admin"),
      payload: { to: "me@example.com" },
    });
    expect(test.statusCode).toBe(200);
    expect(sent.at(-1)!.to).toBe("me@example.com");
  });
});

describe("helpers", () => {
  it("seals and opens secrets", () => {
    const box = secretBox(Buffer.alloc(32, 1));
    const sealed = box.seal("token");
    expect(sealed).not.toContain("token");
    expect(box.open(sealed)).toBe("token");
    expect(() => secretBox(Buffer.alloc(32, 2)).open(sealed)).toThrow();
  });

  it("makes safe filenames", () => {
    expect(safeFilename("Harry Potter / and the: Stone?")).toBe("Harry Potter and the Stone");
    expect(safeFilename("???")).toBe("book");
  });
});
