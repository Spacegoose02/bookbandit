/**
 * Screenshots for the family apps: the Den Duty and Nighttime Ninja cards in Admin → Connections,
 * and Send to kitchen in Cook mode (demo build).
 *   pnpm --filter @bookbandit/web build && pnpm --filter @bookbandit/web exec vite preview --port 4173 &
 *   node apps/web/scripts/screenshots-family-apps.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:4173";
const OUT = path.resolve(__dirname, "../../../docs/screenshots");
fs.mkdirSync(OUT, { recursive: true });
const DATE = process.env.SHOT_DATE || new Date().toISOString().slice(0, 10);

async function shot(page, name) {
  await page.waitForTimeout(600);
  const file = path.join(OUT, `${DATE}-family-apps-${name}.png`);
  await page.screenshot({ path: file });
  console.log("saved", path.basename(file));
}

(async () => {
  const browser = await chromium.launch();
  for (const [label, viewport] of [["desktop", { width: 1280, height: 800 }], ["tablet", { width: 800, height: 1280 }]]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/?demo=admin`);
    await page.waitForSelector(".bb-app");

    await page.goto(`${BASE}/admin/settings`);
    await page.waitForSelector("text=Match kids");
    await page.locator(".bb-admin-card", { hasText: "Den Duty address" }).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -130));
    await shot(page, `connections-${label}`);

    await page.goto(`${BASE}/cook/b12`);
    await page.waitForSelector(".bb-kitchen-send button", { timeout: 15000 });
    await shot(page, `cook-send-${label}`);
    await page.click(".bb-kitchen-send button");
    await page.waitForSelector(".bb-kitchen-ok");
    await shot(page, `cook-sent-${label}`);
    await ctx.close();
  }
  await browser.close();
})();
