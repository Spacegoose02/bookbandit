/**
 * Screenshots for the richer Discover page (demo build): personal, popular, genre and prize rows,
 * for a grown-up and a kid, at desktop and tablet widths.
 *   pnpm --filter @bookbandit/web build && pnpm --filter @bookbandit/web exec vite preview --port 4173 &
 *   node apps/web/scripts/screenshots-discover-rows.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:4173";
const OUT = path.resolve(__dirname, "../../../docs/screenshots");
fs.mkdirSync(OUT, { recursive: true });
const DATE = process.env.SHOT_DATE || new Date().toISOString().slice(0, 10);

async function open(browser, who, viewport, theme) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=${who}`);
  await page.evaluate(([who, theme]) => {
    const id = who === "kid" ? "u-kid" : "u-adult";
    localStorage.setItem(`bb-demo-theme-${id}`, theme);
  }, [who, theme]);
  await page.goto(`${BASE}/discover`);
  await page.waitForSelector(".bb-dcard");
  await page.waitForTimeout(700);
  return { ctx, page };
}

async function shot(page, name, opts = {}) {
  if (opts.fullPage) {
    // Covers load lazily: scroll through once so a full-page shot has them all.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(500);
  }
  const file = path.join(OUT, `${DATE}-web-${name}.png`);
  await page.screenshot({ path: file, ...opts });
  console.log("saved", path.basename(file));
}

async function at(page, sel, name) {
  await page.evaluate((sel) => document.querySelector(sel).scrollIntoView(), sel);
  await page.waitForTimeout(500);
  await shot(page, name);
}

(async () => {
  const browser = await chromium.launch();
  {
    const { ctx, page } = await open(browser, "admin", { width: 1280, height: 800 }, "dark");
    await shot(page, "discover-for-you-desktop");
    await at(page, "#dg-library", "discover-shelves-desktop");
    await at(page, "#dg-moods", "discover-moods-desktop");
    await page.click('.bb-mood-tab:has-text("Spooky")');
    await at(page, "#dg-moods", "discover-moods-spooky-desktop");
    await at(page, "#dg-kids", "discover-for-the-kids-desktop");
    await at(page, "#dg-awards", "discover-prizes-desktop");
    await shot(page, "discover-full-desktop", { fullPage: true });
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, "admin", { width: 800, height: 1280 }, "dark");
    await shot(page, "discover-for-you-tablet");
    await at(page, "#dg-moods", "discover-moods-tablet");
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, "kid", { width: 1280, height: 800 }, "dinosaur");
    await shot(page, "discover-kid-desktop");
    await at(page, "#dg-kids", "discover-kid-themes-desktop");
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, "kid", { width: 800, height: 1280 }, "dinosaur");
    await shot(page, "discover-kid-tablet", { fullPage: true });
    await ctx.close();
  }
  await browser.close();
})();
