/**
 * Screenshots for the themes and kid fun batch (docs/screenshots/*-kids-fun-*.png): the grouped
 * theme picker, kid homes in the new picture themes with the "Pick a book for me" button, the
 * spinner, the buddy picker, the reading garden, a grown-up reader in the new reading themes.
 *   pnpm --filter @bookbandit/web build
 *   pnpm --filter @bookbandit/web preview --port 4173 &
 *   node apps/web/scripts/screenshots-themes-fun.cjs
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

async function open(browser, who, theme, viewport, url = "/", extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ...extra });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=${who}`);
  await page.evaluate(
    ([who, theme]) => {
      const id = who === "kid" ? "u-kid" : "u-adult";
      localStorage.setItem(`bb-demo-theme-${id}`, theme);
      localStorage.setItem("bb-demo-storyteller-settings", JSON.stringify({ enabled: false }));
      localStorage.setItem("bb-storyteller-on-u-kid", "0");
      if (who === "kid") localStorage.setItem("bb-demo-rewards-seen", JSON.stringify(["demo-streak_7"]));
      const progress = (bookId, percent) =>
        localStorage.setItem(
          `bb-demo-progress-${id}-${bookId}`,
          JSON.stringify({ bookId, locator: { kind: "epub", cfi: "", percent }, percent, finished: false, deviceName: "Tablet", clientUpdatedAt: Date.parse("2026-11-13T19:00:00Z"), serverUpdatedAt: Date.parse("2026-11-13T19:00:01Z") }),
        );
      if (who === "kid") (progress("b1", 0.6), progress("b3", 0.2));
    },
    [who, theme],
  );
  await page.goto(`${BASE}${url}`);
  await page.waitForSelector(".bb-app, .bb-reader");
  await page.waitForTimeout(800);
  return { ctx, page };
}

async function shot(page, name, opts = {}) {
  await page.waitForTimeout(400);
  const file = path.join(OUT, `${DATE}-kids-fun-${name}.png`);
  await page.screenshot({ path: file, ...opts });
  console.log("saved", path.basename(file));
}

(async () => {
  const browser = await chromium.launch();

  // Kid homes in the new picture themes.
  for (const [theme, vp, suffix] of [
    ["space", DESKTOP, ""],
    ["sea", TABLET, "-tablet"],
    ["castle", DESKTOP, ""],
    ["builder", TABLET, "-tablet"],
    ["unicorn", DESKTOP, ""],
    ["jungle", DESKTOP, ""],
  ]) {
    const { ctx, page } = await open(browser, "kid", theme, vp);
    await shot(page, `home-${theme}${suffix}`);
    await ctx.close();
  }

  // "Pick a book for me": the landed result (reduced motion lands right away).
  for (const [vp, suffix] of [
    [DESKTOP, ""],
    [TABLET, "-tablet"],
  ]) {
    const { ctx, page } = await open(browser, "kid", "space", vp, "/", { reducedMotion: "reduce" });
    await page.click(".bb-spin-open");
    await page.waitForSelector(".bb-spin-cover.is-done");
    await shot(page, `spinner${suffix}`);
    await ctx.close();
  }

  // Settings: grouped theme picker and the buddy picker, for a kid and a grown-up.
  {
    const { ctx, page } = await open(browser, "kid", "unicorn", DESKTOP, "/settings");
    await shot(page, "kid-settings", { fullPage: true });
    await page.evaluate(() => document.querySelector(".bb-buddies")?.scrollIntoView());
    await shot(page, "buddy-picker");
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, "adult", "sepia", DESKTOP, "/settings");
    await page.evaluate(() => document.querySelector(".bb-theme-groups")?.scrollIntoView());
    await shot(page, "grown-up-themes");
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, "adult", "forest", TABLET, "/settings");
    await page.evaluate(() => document.querySelector(".bb-theme-groups")?.scrollIntoView());
    await shot(page, "grown-up-themes-tablet");
    await ctx.close();
  }

  // Sticker book with the reading garden.
  for (const [vp, suffix, theme] of [
    [DESKTOP, "", "jungle"],
    [TABLET, "-tablet", "sea"],
  ]) {
    const { ctx, page } = await open(browser, "kid", theme, vp, "/stickers");
    await page.waitForSelector(".bb-garden");
    await shot(page, `garden${suffix}`);
    await ctx.close();
  }

  // Celebration with confetti (motion on, caught mid-fall).
  {
    const { ctx, page } = await open(browser, "kid", "castle", DESKTOP);
    await page.evaluate(() => localStorage.removeItem("bb-demo-rewards-seen"));
    await page.reload();
    await page.waitForSelector(".bb-celebrate");
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${DATE}-kids-fun-confetti.png`) });
    console.log("saved confetti");
    await ctx.close();
  }

  // Grown-up home in the new reading themes (one sheet).
  for (const theme of ["sepia", "eink", "amoled", "solarized", "forest", "ocean"]) {
    const { ctx, page } = await open(browser, "adult", theme, DESKTOP, "/browse");
    await shot(page, `grown-up-${theme}`);
    await ctx.close();
  }

  // The reader in two of the new reading themes.
  for (const theme of ["sepia", "eink"]) {
    const { ctx, page } = await open(browser, "adult", theme, DESKTOP, "/read/b2");
    await page.waitForTimeout(2500);
    await shot(page, `reader-${theme}`);
    await ctx.close();
  }

  await browser.close();
})();
