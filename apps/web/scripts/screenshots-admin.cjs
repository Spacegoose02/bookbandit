/**
 * Captures docs/screenshots/*-admin-*.png and *-family-*.png from the demo build.
 *   pnpm --filter @bookbandit/web build
 *   pnpm --filter @bookbandit/web preview --port 4173 &
 *   node apps/web/scripts/screenshots-admin.cjs
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
  await page.waitForSelector(".bb-admin");
  await page.waitForTimeout(500);
  return { ctx, page };
}

async function shot(page, area, name, fullPage = true) {
  // Sticky bars repeat mid-page in full-page captures; pin them to the top for the shot.
  if (fullPage) await page.addStyleTag({ content: ".bb-topbar, .bb-bulkbar { position: static !important; }" });
  await page.waitForTimeout(300);
  const file = path.join(OUT, `${DATE}-${area}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log("saved", path.basename(file));
}

(async () => {
  const browser = await chromium.launch();
  for (const [vp, suffix] of [
    [DESKTOP, ""],
    [TABLET, "-tablet"],
  ]) {
    let { ctx, page } = await open(browser, vp, "/admin");
    await shot(page, "admin", `overview${suffix}`);
    await page.goto(`${BASE}/admin/inbox`);
    await page.waitForSelector(".bb-inbox-row");
    if (!suffix) {
      await page.locator(".bb-inbox-row").nth(2).getByRole("button", { name: "Edit details" }).click();
    }
    await shot(page, "admin", `inbox${suffix}`);
    await page.goto(`${BASE}/family`);
    await page.waitForSelector(".bb-kid-card");
    await shot(page, "family", `dashboard${suffix}`);
    await page.goto(`${BASE}/family/kids/u-kid2`);
    await page.waitForSelector(".bb-chat-summary");
    await page.locator(".bb-chat-summary").first().click();
    await page.waitForSelector(".bb-msg");
    await shot(page, "family", `kid${suffix}`);
    await ctx.close();
  }

  const { ctx, page } = await open(browser, DESKTOP, "/admin/review");
  await page.waitForSelector(".bb-review-row");
  await shot(page, "admin", "needs-rating");
  await page.goto(`${BASE}/admin/people`);
  await page.waitForSelector(".bb-person");
  await page.getByRole("button", { name: "+ Add a kid" }).click();
  await page.fill('.bb-add-form input[required]', "Ruby");
  await page.locator('.bb-add-form input[type="number"]').fill("2020");
  for (const p of ["owl", "frog", "star"]) await page.locator(".bb-add-form").getByRole("button", { name: p, exact: true }).click();
  await shot(page, "admin", "people");
  await page.locator(".bb-devices form input").fill("Ruby's tablet");
  await page.getByRole("button", { name: "Pair a device" }).click();
  await page.waitForSelector(".bb-pair-code");
  await page.locator(".bb-devices").scrollIntoViewIfNeeded();
  await shot(page, "admin", "devices-pairing", false);
  await page.goto(`${BASE}/admin/settings`);
  await page.waitForSelector(".bb-settings-grid");
  await page.getByRole("button", { name: "Save and test" }).click();
  await page.waitForSelector(".bb-ok");
  await shot(page, "admin", "connections");
  await ctx.close();
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
