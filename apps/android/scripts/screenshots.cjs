/**
 * Captures docs/screenshots/<date>-android-*.png from the tablet app's pages in a desktop browser
 * (the Java plugin is replaced by src/mockPlugin.ts there).
 *
 *   pnpm --filter @bookbandit/web build && pnpm --filter @bookbandit/android build
 *   pnpm --filter @bookbandit/android preview &               # www/ on :4174
 *   pnpm --filter @bookbandit/web preview --port 4173 &       # demo data for the book page
 *   pnpm --filter @bookbandit/android screenshots
 * Needs Playwright with Chromium on the machine.
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const APP = process.env.APP_URL || "http://localhost:4174";
const WEB = process.env.WEB_URL || "http://localhost:4173";
const OUT = path.resolve(__dirname, "../../../docs/screenshots");
const DATE = process.env.SHOT_DATE || new Date().toISOString().slice(0, 10);
const PORTRAIT = { width: 800, height: 1280 };
const LANDSCAPE = { width: 1280, height: 800 };
fs.mkdirSync(OUT, { recursive: true });

async function shot(page, name) {
  const file = path.join(OUT, `${DATE}-android-${name}.png`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: file });
  console.log(file);
}

/** What apps/android/src/shim.ts gives the web app inside the APK. */
function fakeNative(status) {
  window.BookBanditNative = {
    platform: "android",
    appVersion: "0.2.0",
    deviceName: "Ada's Fire tablet",
    download: async () => {},
    removeDownload: async () => {},
    downloadStatus: async () => status,
    onDownload: () => () => {},
    pinScreen: async () => {},
    openTabletSettings: () => {},
  };
}

(async () => {
  const browser = await chromium.launch();
  for (const [label, viewport] of [
    ["", PORTRAIT],
    ["-landscape", LANDSCAPE],
  ]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();

    await page.goto(`${APP}/native/setup.html`);
    await page.waitForSelector("#step-choose:not([hidden])");
    await shot(page, `setup${label}`);

    if (!label) {
      await page.click("#choose-type");
      await page.fill("#server", "192.168.1.20:8080");
      await page.locator("#server").blur();
      await page.fill("#code", "K7QM-4XPA");
      await page.fill("#name", "Ada's Fire tablet");
      await page.fill("#pin", "2468");
      await page.fill("#pin2", "2468");
      await shot(page, "setup-code");

      await page.goto(`${APP}/native/settings.html?paired`);
      await page.waitForSelector("#gate:not([hidden])");
      await shot(page, "settings-pin");
    }

    await page.goto(`${APP}/native/settings.html?paired`);
    await page.waitForSelector("#gate:not([hidden])");
    for (const k of ["1", "2", "3", "4", "OK"]) await page.click(`#pad button[aria-label="${k === "OK" ? "Enter" : k}"]`);
    await page.waitForSelector("#content:not([hidden])");
    await page.waitForSelector("#downloads li");
    await shot(page, `settings${label}`);

    if (!label) {
      const web = await ctx.newPage();
      await web.addInitScript(fakeNative, "none");
      await web.goto(`${WEB}/book/b1?demo=adult`);
      await web.waitForSelector("text=Save for offline");
      await shot(web, "book-save-offline");

      const done = await ctx.newPage();
      await done.addInitScript(fakeNative, "done");
      await done.goto(`${WEB}/book/b1?demo=kid`);
      await done.waitForSelector("text=On this tablet");
      await shot(done, "book-saved");
    }
    await ctx.close();
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
