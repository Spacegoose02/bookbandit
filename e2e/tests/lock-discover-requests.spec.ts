/** Discover and book requests: neither may reveal that a locked book is in the library. */
import { expect, test } from "@playwright/test";
import { BOOKS, KID_LOCKED } from "../support/library.js";
import { bearer, progressBody, world } from "../support/state.js";

test("Discover's family shelf never shows a kid a locked book", async ({ request }) => {
  const w = world();
  // Dad reads the adult book so it becomes "popular in your family".
  const put = await request.put(`/api/progress/${w.books.adult.id}`, {
    headers: bearer(w.dad.token),
    data: progressBody(0.4),
  });
  expect(put.ok()).toBeTruthy();

  const dadView = JSON.stringify(await (await request.get("/api/discover", { headers: bearer(w.dad.token) })).json());
  expect(dadView).toContain(BOOKS.adult.title);

  const kid = await request.get("/api/discover", { headers: bearer(w.emma.token) });
  expect(kid.status()).toBe(200);
  const kidView = JSON.stringify(await kid.json());
  for (const k of KID_LOCKED) expect(kidView).not.toContain(BOOKS[k].title);
});

test("requesting a locked title doesn't say it's already in the library", async ({ request }) => {
  const w = world();
  const kid = bearer(w.emma.token);
  // A book she can see: "already in the library", with the book.
  const owned = await request.post("/api/requests", { headers: kid, data: { title: BOOKS.kids.title } });
  expect(owned.status()).toBe(409);
  expect((await owned.json()).book.id).toBe(w.books.kids.id);

  // A locked one: a normal request waiting for a parent, with no trace of the library copy.
  for (const k of ["adult", "explicit"] as const) {
    const res = await request.post("/api/requests", { headers: kid, data: { title: BOOKS[k].title } });
    expect(res.status(), k).toBeLessThan(300);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(w.books[k].id);
    expect(body).not.toContain("already_in_library");
  }
  const mine = JSON.stringify(await (await request.get("/api/requests", { headers: kid })).json());
  for (const k of KID_LOCKED) expect(mine).not.toContain(w.books[k].id);
});
