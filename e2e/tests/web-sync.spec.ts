/** Reading on one browser and picking up on another. */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { BOOKS } from "../support/library.js";
import { world } from "../support/state.js";

async function signedIn(browser: Browser): Promise<Page> {
  const w = world();
  const ctx = await browser.newContext({ baseURL: w.baseURL, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByLabel("Username").fill(w.dad.username);
  await page.getByLabel("Password").fill(w.dad.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(BOOKS.kids.title).first()).toBeVisible();
  return page;
}

/** Open the reader and move to `fraction` of the book, waiting for the position to reach the server. */
async function readTo(page: Page, bookId: string, fraction: number) {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.goto(`/read/${bookId}`);
  // foliate renders pages in a closed shadow root; the location readout means the book is laid out.
  await expect(page.getByText(/loc \d+ of \d+/)).toBeVisible({ timeout: 15_000 });
  const saved = page.waitForRequest((r) => r.method() === "PUT" && r.url().includes(`/api/progress/${bookId}`), { timeout: 20_000 });
  await page.getByLabel("Position in book").fill(String(Math.round(fraction * 1000)));
  await saved;
  // Moving inside the book after the jump keeps the position flowing too.
  await page.getByRole("button", { name: "Next page" }).click();
  expect(violations, "the reader ran into the Content-Security-Policy").toEqual([]);
}

test("reading position follows Dad from one browser to another", async ({ browser }) => {
  const w = world();
  const book = w.books.kids;
  const laptop = await signedIn(browser);
  const tablet = await signedIn(browser);

  await readTo(laptop, book.id, 0.55);
  await laptop.waitForTimeout(500);

  // The other browser shows the same place, from the server.
  await tablet.goto(`/book/${book.id}`);
  const keepReading = tablet.getByRole("link", { name: /keep reading \((\d+)%\)/i }).or(tablet.getByRole("button", { name: /keep reading \((\d+)%\)/i }));
  await expect(keepReading).toBeVisible();
  const pct = Number(/\((\d+)%\)/.exec((await keepReading.textContent()) ?? "")?.[1]);
  expect(pct).toBeGreaterThanOrEqual(45);
  expect(pct).toBeLessThanOrEqual(70);

  // Read further on the tablet; the laptop sees that next time it looks.
  await readTo(tablet, book.id, 0.85);
  await tablet.waitForTimeout(500);
  await laptop.goto(`/book/${book.id}`);
  const again = laptop.getByRole("link", { name: /keep reading/i }).or(laptop.getByRole("button", { name: /keep reading/i }));
  const pct2 = Number(/\((\d+)%\)/.exec((await again.textContent()) ?? "")?.[1]);
  expect(pct2).toBeGreaterThanOrEqual(75);

  // Continue reading on the home page lists it for both.
  await laptop.goto("/");
  await expect(laptop.getByRole("heading", { name: /continue reading/i })).toBeVisible();

  await laptop.context().close();
  await tablet.context().close();
});
