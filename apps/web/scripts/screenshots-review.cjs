/**
 * Captures the one-flow review screens (Inbox with Barnaby's picks, Needs a rating, the rating
 * helper settings) from the demo build.
 *   pnpm --filter @bookbandit/web build
 *   pnpm --filter @bookbandit/web preview --port 4173 &
 *   node apps/web/scripts/screenshots-review.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:4173";
const OUT = path.resolve(__dirname, "../../../docs/screenshots");
fs.mkdirSync(OUT, { recursive: true });
const DATE = process.env.SHOT_DATE || new Date().toISOString().slice(0, 10);
const DESKTOP = { width: 1280, height: 800 };
const TABLET = { width: 800, height: 1280 };

async function open(browser, viewport, url) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=adult`);
  await page.evaluate(() => localStorage.setItem("bb-demo-theme-u-adult", "dark"));
  await page.goto(`${BASE}${url}`);
  await page.waitForTimeout(700);
  return { ctx, page };
}

async function shot(page, name, fullPage = true) {
  if (fullPage) await page.addStyleTag({ content: ".bb-topbar, .bb-bulkbar { position: static !important; }" });
  await page.waitForTimeout(300);
  const file = path.join(OUT, `${DATE}-admin-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log("saved", path.basename(file));
}

(async () => {
  const browser = await chromium.launch();
  for (const [vp, suffix] of [
    [DESKTOP, ""],
    [TABLET, "-tablet"],
  ]) {
    let { ctx, page } = await open(browser, vp, "/admin/inbox");
    await page.waitForSelector(".bb-inbox-row");
    await page.locator(".bb-inbox-check").nth(0).check();
    await page.locator(".bb-inbox-check").nth(2).check();
    await shot(page, `inbox-barnaby${suffix}`);
    await page.goto(`${BASE}/admin/review`);
    await page.waitForSelector(".bb-review-row");
    await shot(page, `needs-rating-barnaby${suffix}`);
    await ctx.close();
  }
  const { ctx, page } = await open(browser, DESKTOP, "/barnaby/settings");
  const card = page.locator(".bb-settings-card", { has: page.getByRole("heading", { name: "Rating helper" }) });
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: path.join(OUT, `${DATE}-admin-rating-helper-settings.png`) });
  console.log("saved rating-helper-settings");
  await ctx.close();
  await browser.close();
})();
