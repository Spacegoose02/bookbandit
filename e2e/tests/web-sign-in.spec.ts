/** Grown-up sign-in in a real browser. */
import { expect, test } from "@playwright/test";
import { BOOKS } from "../support/library.js";
import { world } from "../support/state.js";

test("a grown-up signs in with a password and sees the library", async ({ page }) => {
  const w = world();
  await page.goto("/");
  await page.getByLabel("Username").fill(w.dad.username);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/wrong username or password/i)).toBeVisible();

  await page.getByLabel("Password").fill(w.dad.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(BOOKS.adult.title).first()).toBeVisible();
  // The session cookie is HttpOnly: page scripts can't read it.
  expect(await page.evaluate(() => document.cookie)).not.toContain("bb_session");
});

test("pages are served with a Content-Security-Policy and the app runs under it", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  const res = await page.goto("/");
  expect(res?.headers()["content-security-policy"]).toContain("script-src 'self'");
  await expect(page.getByLabel("Username")).toBeVisible();
  expect(violations).toEqual([]);
});
