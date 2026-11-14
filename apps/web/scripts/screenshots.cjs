/**
 * Captures docs/screenshots/*.png from the demo build.
 *   pnpm --filter @bookbandit/web build
 *   pnpm --filter @bookbandit/web exec vite preview --port 4173 &
 *   node apps/web/scripts/screenshots.cjs
 * Needs Playwright with Chromium available on the machine.
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:4173";
const OUT = path.resolve(__dirname, "../../../docs/screenshots");
fs.mkdirSync(OUT, { recursive: true });

// docs/screenshots/README.md: YYYY-MM-DD-<area>-<what>.png
const DATE = process.env.SHOT_DATE || new Date().toISOString().slice(0, 10);
const DESKTOP = { width: 1280, height: 800 };
const TABLET = DESKTOP;
const TABLET_PORTRAIT = { width: 800, height: 1280 };
const PHONE = { width: 390, height: 844 };

async function session(browser, who, theme, viewport = TABLET) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=${who}`);
  await page.evaluate(
    ([who, theme]) => {
      const id = who === "kid" ? "u-kid" : "u-adult";
      localStorage.setItem(`bb-demo-theme-${id}`, theme);
      // A little reading progress so "Keep reading" shows up.
      const progress = (bookId, percent) =>
        localStorage.setItem(
          `bb-demo-progress-${id}-${bookId}`,
          JSON.stringify({ bookId, locator: { kind: "epub", cfi: "", percent }, percent, finished: false, deviceName: "Living room tablet", clientUpdatedAt: Date.parse("2026-11-13T19:00:00Z"), serverUpdatedAt: Date.parse("2026-11-13T19:00:01Z") }),
        );
      if (who === "kid") progress("b1", 0.6);
      else (progress("b9", 0.35), progress("b4", 0.8));
    },
    [who, theme],
  );
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".bb-app");
  await page.waitForTimeout(400);
  return { ctx, page };
}

async function shot(page, name) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${DATE}-web-${name}.png`) });
  console.log("saved", name);
}

(async () => {
  const browser = await chromium.launch();

  // Grown-up home and library
  {
    const { ctx, page } = await session(browser, "adult", "dark");
    await shot(page, "home-dark");
    await page.goto(`${BASE}/browse?ratings=kids,middle_grade&yearFrom=2018`);
    await page.waitForSelector(".bb-filters-panel");
    await shot(page, "library-filters");
    await page.goto(`${BASE}/book/b9`);
    await shot(page, "book-page");
    await page.goto(`${BASE}/read/b9`);
    await page.waitForSelector(".bb-foliate");
    await page.waitForTimeout(1500);
    await shot(page, "reader-dark");
    await page.click('[aria-label="Text and colors"]');
    await shot(page, "reader-settings");
    await page.goto(`${BASE}/settings`);
    await shot(page, "theme-picker");
    await ctx.close();
  }

  for (const theme of ["nuclear", "retro", "pink", "school", "gaming", "storm"]) {
    const { ctx, page } = await session(browser, "adult", theme);
    await shot(page, `theme-${theme}`);
    await ctx.close();
  }

  // Kid mode on a tablet
  {
    const { ctx, page } = await session(browser, "kid", "dinosaur");
    await shot(page, "kid-home-dinosaur");
    await page.goto(`${BASE}/read/b1`);
    await page.waitForSelector(".bb-foliate");
    await page.waitForTimeout(1500);
    await shot(page, "kid-reader");
    await ctx.close();
  }
  {
    const { ctx, page } = await session(browser, "kid", "pink", TABLET_PORTRAIT);
    await shot(page, "kid-home-tablet-portrait");
    await ctx.close();
  }
  {
    const { ctx, page } = await session(browser, "adult", "storm", TABLET_PORTRAIT);
    await shot(page, "home-tablet-portrait");
    await page.goto(`${BASE}/read/b9`);
    await page.waitForSelector(".bb-foliate");
    await page.waitForTimeout(1500);
    await shot(page, "reader-tablet-portrait");
    await ctx.close();
  }
  {
    const { ctx, page } = await session(browser, "adult", "light", PHONE);
    await shot(page, "home-phone-light");
    await ctx.close();
  }

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
