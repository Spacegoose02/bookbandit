/**
 * Captures docs/screenshots/*-families-*.png from the demo build: the admin's Families card (with
 * someone waiting for a family), kids grouped by family, and a family parent's own view.
 *   pnpm --filter @bookbandit/web build
 *   pnpm --filter @bookbandit/web preview --port 4173 &
 *   node apps/web/scripts/screenshots-families.cjs
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

async function open(browser, viewport, persona, url, ready) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=${persona}`);
  await page.evaluate(() => {
    localStorage.setItem("bb-demo-theme-u-adult", "dark");
    // The demo kid is a storyteller profile by default; show the reading kid's home instead.
    localStorage.setItem("bb-demo-storyteller-settings", JSON.stringify({ enabled: false }));
    localStorage.setItem("bb-storyteller-on-u-kid", "0");
  });
  await page.goto(`${BASE}${url}`);
  await page.waitForSelector(ready);
  await page.waitForTimeout(500);
  return { ctx, page };
}

async function shot(page, name, fullPage = true) {
  await page.addStyleTag({ content: ".bb-launcher { display: none !important; }" + (fullPage ? " .bb-topbar { position: static !important; }" : "") });
  await page.waitForTimeout(300);
  const file = path.join(OUT, `${DATE}-families-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log("saved", path.basename(file));
}

(async () => {
  const browser = await chromium.launch();
  for (const [vp, suffix] of [
    [DESKTOP, ""],
    [TABLET, "-tablet"],
  ]) {
    // Admin: every family, someone waiting, kids grouped by family.
    let { ctx, page } = await open(browser, vp, "admin", "/admin/people", ".bb-families");
    await shot(page, `admin-people${suffix}`);
    await page.goto(`${BASE}/family`);
    await page.waitForSelector(".bb-kid-card");
    await shot(page, `admin-dashboard${suffix}`);
    await ctx.close();

    // A family parent: only their own family, no server settings.
    ({ ctx, page } = await open(browser, vp, "parent", "/family/people", ".bb-families"));
    await shot(page, `parent-people${suffix}`);
    await page.goto(`${BASE}/family`);
    await page.waitForSelector(".bb-kid-card");
    await shot(page, `parent-dashboard${suffix}`);
    await page.goto(`${BASE}/admin`);
    await page.waitForTimeout(500);
    await shot(page, `parent-no-admin${suffix}`, false);
    // Parent approved: approve from a book's page, see it on the kid's dashboard page.
    await page.goto(`${BASE}/book/b3`);
    await page.waitForSelector(".bb-approve");
    await shot(page, `approve-book${suffix}`, false);
    await page.goto(`${BASE}/family/kids/u-kid`);
    await page.waitForSelector(".bb-approved-item");
    await page.locator(".bb-approved-card").scrollIntoViewIfNeeded();
    await shot(page, `approved-card${suffix}`, false);
    await ctx.close();

    // The kid's home: Parent approved comes right after Keep reading.
    ({ ctx, page } = await open(browser, vp, "kid", "/", ".bb-kid-approved"));
    await page.locator(".bb-kid-approved").scrollIntoViewIfNeeded();
    await shot(page, `kid-home-approved${suffix}`, false);
    await ctx.close();
  }
  await browser.close();
})();
