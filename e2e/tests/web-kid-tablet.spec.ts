/** A 7-year-old on the shared family tablet: picks herself, types her PIN, sees only her books. */
import { expect, test } from "@playwright/test";
import { BOOKS, KID_LOCKED, KID_VISIBLE } from "../support/library.js";
import { world } from "../support/state.js";

test.beforeEach(async ({ context }) => {
  const w = world();
  const url = new URL(w.baseURL);
  await context.addCookies([{ name: "bb_device", value: w.tablet.deviceToken, domain: url.hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
});

test("Emma signs in on the tablet and only her books are there", async ({ page }) => {
  const w = world();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Who's reading?" })).toBeVisible();
  await page.getByRole("button", { name: /Emma/ }).click();

  // A wrong PIN first.
  await page.keyboard.type("1111");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/isn't right/i)).toBeVisible();

  await page.keyboard.type(w.emma.pin);
  await page.keyboard.press("Enter");
  for (const k of KID_VISIBLE) await expect(page.getByText(BOOKS[k].title).first()).toBeVisible();
  const text = await page.locator("body").innerText();
  for (const k of KID_LOCKED) expect(text).not.toContain(BOOKS[k].title);

  // Typing a locked book's address: "can't find", same as a book that doesn't exist.
  for (const k of ["adult", "explicit", "unrated", "inbox"] as const) {
    await page.goto(`/book/${w.books[k].id}`);
    await expect(page.getByText("Barnaby can't find that book")).toBeVisible();
    await expect(page.getByText(BOOKS[k].title)).toHaveCount(0);
  }
  // The same browser session can't fetch the files either.
  for (const k of KID_LOCKED) {
    const res = await page.request.get(`/api/books/${w.books[k].id}/files/${w.books[k].fileId}`);
    expect(res.status(), k).toBe(404);
  }
  // A kid can't open the admin or family areas.
  expect((await page.request.get("/api/admin/inbox")).status()).toBe(403);
  expect((await page.request.post("/api/admin/backups")).status()).toBe(403);

  // Her own book opens in the reader.
  await page.goto(`/read/${w.books.kids.id}`);
  // Kids get Barnaby's progress bar instead of numbers; it appears once the book is laid out.
  await expect(page.getByLabel(/% of the book$/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Barnaby can't find that book")).toHaveCount(0);
});

test("Emma can't change her own limits", async ({ page }) => {
  const w = world();
  await page.goto("/");
  await page.getByRole("button", { name: /Emma/ }).click();
  await page.keyboard.type(w.emma.pin);
  await page.keyboard.press("Enter");
  await expect(page.getByText(BOOKS.kids.title).first()).toBeVisible();

  const older = await page.request.patch(`/api/users/${w.emma.id}`, { data: { birthYear: 1990 } });
  expect(older.status()).toBe(403);
  const ai = await page.request.put(`/api/ai/kids/${w.emma.id}/settings`, { data: { enabled: true, webSearch: true, dailyLimit: 500 } });
  expect(ai.status()).toBe(403);
  const self = await page.request.patch("/api/users/me", { data: { birthYear: 1990 } });
  expect(self.status()).toBeGreaterThanOrEqual(400);
  const list = await page.request.get("/api/books?limit=100");
  expect(((await list.json()).items as { title: string }[]).map((b) => b.title).sort()).toEqual(KID_VISIBLE.map((k) => BOOKS[k].title).sort());
});
