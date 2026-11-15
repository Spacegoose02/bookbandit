/**
 * Families often open BookBandit at a plain-HTTP LAN address (http://192.168.x.x:8080). Browsers
 * leave `crypto.randomUUID` out there (it's secure-context only), and the reader once crashed to a
 * blank page because of it. The test server is on 127.0.0.1, which counts as secure, so remove it
 * by hand to get the same browser as on a LAN address.
 */
import { expect, test } from "@playwright/test";
import { BOOKS } from "../support/library.js";
import { world } from "../support/state.js";

for (const vp of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 800, height: 1280 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`the reader opens without crypto.randomUUID (${vp.name})`, async ({ browser }) => {
    const w = world();
    const ctx = await browser.newContext({ baseURL: w.baseURL, viewport: { width: vp.width, height: vp.height } });
    await ctx.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, "randomUUID", { value: undefined, configurable: true });
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/");
    await page.getByLabel("Username").fill(w.dad.username);
    await page.getByLabel("Password").fill(w.dad.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(BOOKS.kids.title).first()).toBeVisible();
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");

    await page.goto(`/book/${w.books.adult.id}`);
    await page.getByRole("link", { name: /^(Read|Keep reading)/ }).first().click();
    await expect(page.getByRole("button", { name: "Close book" })).toBeVisible();
    await expect(page.getByText(/loc \d+ of \d+/)).toBeVisible({ timeout: 15_000 });
    // Bookmarks also make their ids in the browser.
    await page.getByRole("button", { name: "Bookmark this page" }).click();
    await expect(page.getByRole("button", { name: "Remove bookmark" })).toBeVisible();
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/2026-11-15-web-reader-lan-http-${vp.name}.png` });
    expect(errors).toEqual([]);
  });
}
