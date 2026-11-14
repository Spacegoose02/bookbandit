/**
 * Captures docs/screenshots/*-librarian-*.png from the demo build.
 *   pnpm --filter @bookbandit/web build
 *   pnpm --filter @bookbandit/web preview --port 4173 &
 *   node apps/web/scripts/screenshots-librarian.cjs
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
  await page.waitForSelector(".bb-librarian");
  // The floating "Ask Barnaby" button covers table columns in captures.
  await page.addStyleTag({ content: ".bb-launcher { display: none !important; }" });
  await page.waitForTimeout(500);
  return { ctx, page };
}

async function shot(page, name, fullPage = true) {
  if (fullPage) await page.addStyleTag({ content: ".bb-topbar, .bb-lib-bulk { position: static !important; }" });
  await page.waitForTimeout(300);
  const file = path.join(OUT, `${DATE}-librarian-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log("saved", path.basename(file));
}

(async () => {
  const browser = await chromium.launch();
  for (const [vp, suffix] of [
    [DESKTOP, ""],
    [TABLET, "-tablet"],
  ]) {
    const { ctx, page } = await open(browser, vp, "/admin/librarian");
    await page.waitForSelector(".bb-lib-problems");
    await shot(page, `health${suffix}`);

    const nav = async (url) => {
      await page.goto(`${BASE}${url}`);
      await page.addStyleTag({ content: ".bb-launcher { display: none !important; }" });
    };
    await nav("/admin/librarian/duplicates");
    await page.waitForSelector(".bb-dupe-group");
    await shot(page, `duplicates${suffix}`);

    await nav("/admin/librarian/books?q=");
    await page.waitForSelector(".bb-lib-tr:not(.is-head)");
    await page.getByPlaceholder("Search title, author or series").fill("Ada");
    await page.waitForTimeout(600);
    await page.getByLabel("Select this page").check();
    await page.getByPlaceholder("Pebble Bay").fill("Pebble Bay");
    await shot(page, `bulk-edit${suffix}`, !suffix);
    if (!suffix) {
      await page.getByRole("button", { name: /Apply to 10 books/ }).click();
      await page.waitForSelector(".bb-ok");
      await shot(page, "bulk-edit-done");
      await page.getByRole("button", { name: "Change cover of The Lighthouse Key" }).click();
      await page.waitForSelector(".bb-cover-cand");
      await page.locator(".bb-cover-cand").nth(1).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `${DATE}-librarian-cover-editor.png`) });
      console.log("saved cover-editor");
      await page.getByRole("button", { name: "Crop this cover" }).click();
      await page.waitForSelector(".bb-crop-frame img");
      await page.getByLabel("Zoom").fill("1.8");
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `${DATE}-librarian-cover-crop.png`) });
      console.log("saved cover-crop");
    }

    await nav("/admin/librarian/convert");
    await page.waitForSelector(".bb-lib-jobs");
    await shot(page, `convert${suffix}`);
    await ctx.close();
  }
  await browser.close();
})();
