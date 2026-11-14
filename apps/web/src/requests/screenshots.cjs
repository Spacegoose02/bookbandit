/**
 * Screenshots of the requests pages from the demo build (desktop 1280x800 and tablet 800x1280).
 *   pnpm --filter @bookbandit/web build && pnpm --filter @bookbandit/web preview --port 4173 &
 *   node apps/web/src/requests/screenshots.cjs docs/screenshots
 */
const path = require("node:path");
const { chromium } = require("playwright");
const BASE = "http://localhost:4173";
const OUT = process.argv[2];
const DESKTOP = { width: 1280, height: 800 }, TABLET = { width: 800, height: 1280 };
async function session(browser, who, theme, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(`${BASE}/?demo=${who}`);
  await page.evaluate(([who, theme]) => localStorage.setItem(`bb-demo-theme-${who === "kid" ? "u-kid" : "u-adult"}`, theme), [who, theme]);
  return { ctx, page };
}
async function shot(page, name) { await page.waitForTimeout(700); await page.screenshot({ path: path.join(OUT, `2026-11-14-requests-${name}.png`) }); console.log("saved", name); }
(async () => {
  const b = await chromium.launch();
  for (const [vp, suffix] of [[DESKTOP, ""], [TABLET, "-tablet"]]) {
    { const { ctx, page } = await session(b, "adult", "dark", vp);
      await page.goto(`${BASE}/requests?tab=ask&q=wild robot`); await page.waitForSelector(".bb-cand"); await shot(page, `ask${suffix}`);
      await page.goto(`${BASE}/requests?tab=approve`); await page.waitForSelector(".bb-req"); await shot(page, `approve${suffix}`);
      await ctx.close(); }
    { const { ctx, page } = await session(b, "kid", "dinosaur", vp);
      await page.goto(`${BASE}/requests`); await page.waitForSelector(".bb-kid-wishrow");
      await page.fill(".bb-kid-search", "dinosaur"); await page.waitForSelector(".bb-kid-wish");
      await shot(page, `kid-wishes${suffix}`); await ctx.close(); }
    { const { ctx, page } = await session(b, "admin", "dark", vp);
      await page.goto(`${BASE}/requests?tab=downloads`); await page.waitForSelector(".bb-job");
      await page.click(".bb-job-head >> nth=0"); await page.waitForSelector(".bb-log"); await shot(page, `downloads${suffix}`);
      await page.goto(`${BASE}/requests?tab=settings`); await page.waitForSelector(".bb-dl-settings"); await shot(page, `downloaders${suffix}`);
      await page.goto(`${BASE}/requests?tab=upload`); await page.waitForSelector(".bb-drop"); await shot(page, `upload${suffix}`);
      await ctx.close(); }
  }
  { const { ctx, page } = await session(b, "kid", "dinosaur", DESKTOP);
    await page.goto(`${BASE}/`); await page.waitForSelector(".bb-kid-ask-link"); await shot(page, "kid-home-wish-button"); await ctx.close(); }
  await b.close();
})();
