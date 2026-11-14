/**
 * Screenshots for Discover, series, categories, Cook mode and the Kindle import (demo build).
 *   pnpm --filter @bookbandit/web build && pnpm --filter @bookbandit/web exec vite preview --port 4173 &
 *   node apps/web/scripts/screenshots-discover.cjs
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

async function session(browser, who, viewport, theme = "dark") {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=${who}`);
  await page.evaluate(([who, theme]) => {
    const id = who === "kid" ? "u-kid" : "u-adult";
    localStorage.setItem(`bb-demo-theme-${id}`, theme);
    const progress = (bookId, percent) =>
      localStorage.setItem(
        `bb-demo-progress-${id}-${bookId}`,
        JSON.stringify({ bookId, locator: { kind: "epub", cfi: "", percent }, percent, finished: percent >= 1, deviceName: "Tablet", clientUpdatedAt: 1, serverUpdatedAt: 1 }),
      );
    if (who !== "kid") (progress("b4", 1), progress("b5", 0.4));
  }, [who, theme]);
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".bb-app");
  return { ctx, page };
}

async function shot(page, name) {
  await page.waitForTimeout(600);
  const file = path.join(OUT, `${DATE}-web-${name}.png`);
  await page.screenshot({ path: file });
  console.log("saved", path.basename(file));
}

(async () => {
  const browser = await chromium.launch();
  for (const [label, viewport] of [["desktop", DESKTOP], ["tablet", TABLET]]) {
    const { ctx, page } = await session(browser, "admin", viewport);
    await page.goto(`${BASE}/discover`);
    await page.waitForSelector(".bb-dcard");
    await shot(page, `discover-${label}`);
    await page.goto(`${BASE}/series`);
    await page.waitForSelector(".bb-cat-tile");
    await shot(page, `series-list-${label}`);
    await page.goto(`${BASE}/series/${encodeURIComponent("series:Pebble Bay")}`);
    await page.waitForSelector(".bb-series-row");
    await shot(page, `series-page-${label}`);
    await page.click("text=Edit series");
    await page.waitForSelector(".bb-series-edit");
    await shot(page, `series-edit-${label}`);
    await page.goto(`${BASE}/categories`);
    await page.waitForSelector(".bb-cat-tile");
    await shot(page, `categories-${label}`);
    await page.goto(`${BASE}/categories/cat-cook`);
    await page.waitForSelector(".bb-card");
    await shot(page, `category-cookbooks-${label}`);
    await page.goto(`${BASE}/book/b12`);
    await page.waitForSelector("text=Cook mode");
    await shot(page, `book-cookbook-${label}`);
    await page.goto(`${BASE}/cook/b12`);
    await page.waitForSelector(".bb-foliate");
    await page.waitForTimeout(1500);
    if (label === "tablet") await page.click(".bb-cook-recipes-btn");
    await shot(page, `cook-mode-${label}`);
    await page.goto(`${BASE}/discover/kindle-import`);
    await page.fill("#kindle-csv", "ASIN,Title,Author\nB00ZV9PXP2,Mistborn: The Final Empire,Brandon Sanderson\nB08FHBV4ZX,Project Hail Mary,Andy Weir\nB000DEMO00,A Quiet Year in Kyoto,Hana Mori");
    await page.click('button:has-text("Dry run")');
    await page.waitForSelector(".bb-report");
    await shot(page, `kindle-import-${label}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await session(browser, "kid", TABLET, "dinosaur");
    await page.goto(`${BASE}/discover`);
    await page.waitForSelector(".bb-dcard");
    await shot(page, "discover-kid-tablet");
    await ctx.close();
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
