/**
 * The content lock from the web API: everything a 7-year-old's session can ask for.
 * Locked books must look missing (404), never forbidden, and never show up in lists or search.
 */
import { expect, test } from "@playwright/test";
import { BOOKS, KID_LOCKED, KID_VISIBLE } from "../support/library.js";
import { bearer, progressBody, world } from "../support/state.js";

const kid = () => bearer(world().emma.token);
const titlesOf = (items: { title: string }[]) => items.map((b) => b.title).sort();
const lockedTitles = KID_LOCKED.map((k) => BOOKS[k].title);

test("the book list and search show a kid only their books", async ({ request }) => {
  const list = await request.get("/api/books?limit=100", { headers: kid() });
  expect(list.status()).toBe(200);
  expect(titlesOf((await list.json()).items)).toEqual(KID_VISIBLE.map((k) => BOOKS[k].title).sort());

  for (const title of lockedTitles) {
    const q = await request.get(`/api/books?q=${encodeURIComponent(title)}`, { headers: kid() });
    expect((await q.json()).items, `search for "${title}"`).toEqual([]);
  }
  const authors = await request.get("/api/authors", { headers: kid() });
  const names = JSON.stringify(await authors.json());
  for (const k of ["adult", "explicit", "teen", "unrated"] as const) expect(names).not.toContain(BOOKS[k].author);
});

test("locked books, their files, covers and progress are 404 for a kid", async ({ request }) => {
  const w = world();
  for (const k of KID_LOCKED) {
    const b = w.books[k];
    for (const path of [`/api/books/${b.id}`, `/api/books/${b.id}/files/${b.fileId}`, `/api/books/${b.id}/cover`, `/api/progress/${b.id}`, `/api/books/${b.id}/bookmarks`]) {
      const res = await request.get(path, { headers: kid() });
      expect(res.status(), `${k}: GET ${path}`).toBe(404);
    }
    const put = await request.put(`/api/progress/${b.id}`, {
      headers: kid(),
      data: progressBody(0.1),
    });
    expect(put.status(), `${k}: PUT progress`).toBe(404);
  }
  // A book the kid may see still opens.
  const ok = await request.get(`/api/books/${w.books.kids.id}/files/${w.books.kids.fileId}`, { headers: kid() });
  expect(ok.status()).toBe(200);
});

test("home shelves, series and categories leave locked books out", async ({ request }) => {
  const w = world();
  const shelves = JSON.stringify(await (await request.get("/api/shelves", { headers: kid() })).json());
  for (const t of lockedTitles) expect(shelves).not.toContain(t);
  expect(shelves).toContain(BOOKS.kids.title);

  const series = await request.get(`/api/series/${w.seriesId}`, { headers: kid() });
  expect(series.status()).toBe(200);
  expect(titlesOf((await series.json()).books)).toEqual(KID_VISIBLE.map((k) => BOOKS[k].title).sort());
  const seriesList = JSON.stringify(await (await request.get("/api/series", { headers: kid() })).json());
  for (const t of lockedTitles) expect(seriesList).not.toContain(t);

  const cat = JSON.stringify(await (await request.get(`/api/categories/${w.categoryId}`, { headers: kid() })).json());
  for (const t of lockedTitles) expect(cat).not.toContain(t);
  expect(cat).toContain(BOOKS.kids.title);
});

test("a parent sees adult and unrated books but never explicit or the inbox", async ({ request }) => {
  const w = world();
  const dad = bearer(w.dad.token);
  for (const k of ["kids", "teen", "adult", "unrated"] as const) {
    expect((await request.get(`/api/books/${w.books[k].id}`, { headers: dad })).status(), k).toBe(200);
  }
  for (const k of ["explicit", "inbox"] as const) {
    expect((await request.get(`/api/books/${w.books[k].id}`, { headers: dad })).status(), k).toBe(404);
  }
  // The admin sees the inbox book (it's theirs to approve).
  expect((await request.get(`/api/books/${w.books.inbox.id}`, { headers: bearer(w.admin.token) })).status()).toBe(200);
});

test("signed-out callers get nothing", async ({ request }) => {
  const w = world();
  expect((await request.get("/api/books")).status()).toBe(401);
  expect((await request.get(`/api/books/${w.books.kids.id}/files/${w.books.kids.fileId}`)).status()).toBe(401);
});
