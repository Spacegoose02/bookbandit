/**
 * Captures docs/screenshots/*-admin-import-*.png (the "Move in" page) from the demo build.
 *   pnpm --filter @bookbandit/web build
 *   pnpm --filter @bookbandit/web preview --port 4173 &
 *   node apps/web/scripts/screenshots-imports.cjs
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

async function open(browser, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=adult`);
  await page.evaluate(() => localStorage.setItem("bb-demo-theme-u-adult", "dark"));
  await page.goto(`${BASE}/admin/import`);
  await page.waitForSelector(".bb-import-sources");
  await page.waitForTimeout(400);
  return { ctx, page };
}

async function shot(page, name) {
  await page.addStyleTag({ content: ".bb-topbar { position: static !important; }" });
  await page.waitForTimeout(300);
  const file = path.join(OUT, `${DATE}-admin-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log("saved", path.basename(file));
}

async function dryRun(page) {
  await page.getByRole("button", { name: "Dry run" }).click();
  await page.waitForSelector(".bb-import-report");
}

(async () => {
  const browser = await chromium.launch();
  for (const [vp, suffix] of [
    [DESKTOP, ""],
    [TABLET, "-tablet"],
  ]) {
    const { ctx, page } = await open(browser, vp);
    await page.getByLabel(/Calibre library: folder/).fill("/books/Calibre Library");
    await dryRun(page);
    await shot(page, `import-calibre${suffix}`);
    await ctx.close();
  }

  const { ctx, page } = await open(browser, DESKTOP);
  await page.getByRole("tab", { name: /Calibre-Web/ }).click();
  await page.getByLabel(/Calibre-Web database: folder/).fill("/config/calibre-web");
  await dryRun(page);
  await page.waitForSelector(".bb-import-people");
  await shot(page, "import-calibre-web");

  await page.getByRole("tab", { name: /Goodreads/ }).click();
  await page.getByLabel("Person", { exact: true }).selectOption({ label: "Alex" });
  await page.getByLabel("Export file (.csv)").setInputFiles({ name: "goodreads_library_export.csv", mimeType: "text/csv", buffer: Buffer.from("Book Id,Title\n1,Dune\n") });
  await page.waitForSelector(".bb-ok");
  await dryRun(page);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.waitForSelector("text=Import finished");
  await shot(page, "import-goodreads");
  await ctx.close();
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
