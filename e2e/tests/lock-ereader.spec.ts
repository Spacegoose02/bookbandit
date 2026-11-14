/** OPDS, Kobo sync and KOReader sync with a kid's e-reader sign-in. */
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { BOOKS, KID_LOCKED, KID_VISIBLE } from "../support/library.js";
import { basic, bearer, progressBody, world } from "../support/state.js";

const lockedTitles = KID_LOCKED.map((k) => BOOKS[k].title);

test("OPDS feeds and search only list a kid's books, and locked files are 404", async ({ request }) => {
  const w = world();
  const kid = basic(w.ereader.emma.username, w.ereader.emma.password);
  for (const path of ["/opds/books", "/opds/new", "/opds/authors", "/opds/series", "/opds/genres", "/opds/kid"]) {
    const res = await request.get(path, { headers: kid });
    expect(res.status(), path).toBe(200);
    const xml = await res.text();
    for (const t of lockedTitles) expect(xml, `${path} lists "${t}"`).not.toContain(t);
  }
  const all = await (await request.get("/opds/books", { headers: kid })).text();
  for (const k of KID_VISIBLE) expect(all).toContain(BOOKS[k].title);

  for (const t of lockedTitles) {
    const xml = await (await request.get(`/opds/search?q=${encodeURIComponent(t)}`, { headers: kid })).text();
    expect(xml, `search for "${t}"`).not.toContain("<entry");
    expect(xml).toContain("<opensearch:totalResults>0<");
  }
  for (const k of KID_LOCKED) {
    const b = w.books[k];
    expect((await request.get(`/opds/books/${b.id}/files/${b.fileId}`, { headers: kid })).status(), k).toBe(404);
    expect((await request.get(`/opds/books/${b.id}/cover`, { headers: kid })).status(), k).toBe(404);
  }
  // Control: Dad's login sees the adult book, so the check above can fail.
  const dad = await (await request.get("/opds/books", { headers: basic(w.ereader.dad.username, w.ereader.dad.password) })).text();
  expect(dad).toContain(BOOKS.adult.title);
  // A wrong password is a 401 with a Basic challenge, not an empty feed.
  const wrong = await request.get("/opds/books", { headers: basic(w.ereader.emma.username, "nope") });
  expect(wrong.status()).toBe(401);
});

test("Kobo sync never hands a kid's Kobo a locked book", async ({ request }) => {
  const w = world();
  const sync = async (token: string) => {
    const res = await request.get(`/kobo/${token}/v1/library/sync`);
    expect(res.status()).toBe(200);
    return JSON.stringify(await res.json());
  };
  const kid = await sync(w.ereader.emma.koboToken);
  for (const t of lockedTitles) expect(kid).not.toContain(t);
  expect(kid).toContain(BOOKS.kids.title);
  expect(await sync(w.ereader.dad.koboToken)).toContain(BOOKS.adult.title);

  for (const k of KID_LOCKED) {
    const b = w.books[k];
    const dl = await request.get(`/kobo/${w.ereader.emma.koboToken}/download/${b.id}/epub`);
    expect(dl.status(), k).toBe(404);
    const meta = await request.get(`/kobo/${w.ereader.emma.koboToken}/v1/library/${b.id}/metadata`);
    expect(meta.status(), k).toBe(404);
  }
});

/** KOReader's document id: MD5 of 1 KB samples at 1 KB · 4^i offsets. */
function partialMd5(file: string): string {
  const fd = openSync(file, "r");
  const size = statSync(file).size;
  const hash = createHash("md5");
  const buf = Buffer.alloc(1024);
  try {
    for (let i = -1; i <= 10; i++) {
      const offset = 1024 << (2 * i);
      if (offset >= size) break;
      const n = readSync(fd, buf, 0, 1024, offset);
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

test("KOReader sync doesn't link a kid's position to a locked book", async ({ request }) => {
  const w = world();
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  const kid = { "x-auth-user": w.ereader.emma.username, "x-auth-key": md5(w.ereader.emma.password), accept: "application/vnd.koreader.v1+json" };
  expect((await request.get("/kosync/users/auth", { headers: kid })).status()).toBe(200);

  // Dad reads the adult book on the web, so there is a position to leak.
  await request.put(`/api/progress/${w.books.adult.id}`, {
    headers: bearer(w.dad.token),
    data: progressBody(0.5),
  });

  const adultDoc = partialMd5(join(w.booksDir, w.books.adult.relPath));
  const kidsDoc = partialMd5(join(w.booksDir, w.books.kids.relPath));
  // KOReader learns digests from a scan of the library; warm it with Dad's own sync first.
  const dad = { "x-auth-user": w.ereader.dad.username, "x-auth-key": md5(w.ereader.dad.password), accept: "application/vnd.koreader.v1+json" };
  const dadGet = await request.get(`/kosync/syncs/progress/${adultDoc}`, { headers: dad });
  expect((await dadGet.json()).percentage, "control: Dad's KOReader sees his web position").toBeCloseTo(0.5);

  const kidGet = await request.get(`/kosync/syncs/progress/${adultDoc}`, { headers: kid });
  expect(await kidGet.json()).toEqual({});

  const put = await request.put("/kosync/syncs/progress", {
    headers: { ...kid, "content-type": "application/json" },
    data: { document: adultDoc, progress: "/body/DocFragment[2]/body/p[3]/text().0", percentage: 0.3, device: "Kobo", device_id: "e2e" },
  });
  expect(put.status()).toBe(200);
  expect((await request.get(`/api/progress/${w.books.adult.id}`, { headers: bearer(w.emma.token) })).status()).toBe(404);
  const cont = JSON.stringify(await (await request.get("/api/shelves/continue", { headers: bearer(w.emma.token) })).json());
  expect(cont).not.toContain(w.books.adult.id);

  // Control: the same thing on her own book lands in Continue reading.
  await request.put("/kosync/syncs/progress", {
    headers: { ...kid, "content-type": "application/json" },
    data: { document: kidsDoc, progress: "/body/DocFragment[2]/body/p[3]/text().0", percentage: 0.3, device: "Kobo", device_id: "e2e" },
  });
  const after = JSON.stringify(await (await request.get("/api/shelves/continue", { headers: bearer(w.emma.token) })).json());
  expect(after).toContain(w.books.kids.id);
});
