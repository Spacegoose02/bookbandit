/**
 * Barnaby round 2 screenshots (more like this, meaning search, find a book, streaming,
 * metadata cleanup) into docs/screenshots/ from the demo build.
 *   pnpm --filter @bookbandit/web build && pnpm --filter @bookbandit/web preview --port 4173 &
 *   node apps/web/scripts/screenshots-ai-round2.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:4173";
const OUT = path.resolve(__dirname, "../../../docs/screenshots");
fs.mkdirSync(OUT, { recursive: true });
const DATE = process.env.SHOT_DATE || new Date().toISOString().slice(0, 10);
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, tablet: { width: 800, height: 1280 } };

async function session(browser, who, theme, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=${who}`);
  await page.evaluate(([who, theme]) => localStorage.setItem(`bb-demo-theme-${who === "kid" ? "u-kid" : "u-adult"}`, theme), [who, theme]);
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".bb-app");
  return { ctx, page };
}

async function shot(page, name, opts = {}) {
  await page.waitForTimeout(opts.wait ?? 600);
  await page.screenshot({ path: path.join(OUT, `${DATE}-ai-${name}.png`), fullPage: !!opts.full });
  console.log("saved", name);
}

(async () => {
  const browser = await chromium.launch();
  for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
    {
      const { ctx, page } = await session(browser, "adult", "dark", viewport);
      // More like this on a book page.
      await page.goto(`${BASE}/book/b7`);
      await page.waitForSelector(".bb-more-like .bb-card");
      await page.locator(".bb-more-like").scrollIntoViewIfNeeded();
      await shot(page, `more-like-this-${vp}`);
      // Library search: no title matches, but Barnaby finds books by what they're about.
      await page.goto(`${BASE}/browse?q=${encodeURIComponent("something sleepy by the sea")}`);
      await page.waitForSelector(".bb-meaning .bb-card");
      await page.evaluate(() => document.querySelector(".bb-empty, .bb-barnaby-empty")?.scrollIntoView({ block: "start" }));
      await page.evaluate(() => window.scrollBy(0, 260));
      await shot(page, `meaning-search-${vp}`);
      // Find a book.
      await page.goto(`${BASE}/barnaby/find`);
      await page.waitForSelector(".bb-find-form");
      await page.fill(".bb-find-form input", "Something like Pixel Quest for a 10-year-old");
      await page.click(".bb-find-form button[type=submit]");
      await page.waitForSelector(".bb-find-picks li");
      await shot(page, `find-a-book-${vp}`, { full: vp === "desktop" });
      // Streaming: caught mid-sentence.
      await page.goto(`${BASE}/barnaby`);
      await page.waitForSelector(".bb-chat");
      await page.fill(".bb-chat-input textarea", "Something cozy for a rainy evening");
      await page.click(".bb-chat-send");
      await page.waitForSelector(".bb-chat-streaming");
      await page.waitForTimeout(180);
      await shot(page, `streaming-${vp}`, { wait: 0 });
      // Settings: meaning search and metadata cleanup.
      await page.goto(`${BASE}/barnaby/settings`);
      await page.waitForSelector(".bb-meta-suggestions li");
      await page.evaluate(() => [...document.querySelectorAll(".bb-settings-card h2")].find((h) => h.textContent === "Meaning search")?.scrollIntoView({ block: "start" }));
      await page.evaluate(() => window.scrollBy(0, -90));
      await shot(page, `settings-meaning-metadata-${vp}`);
      await ctx.close();
    }
    {
      const { ctx, page } = await session(browser, "kid", "dinosaur", viewport);
      await page.goto(`${BASE}/book/b1`);
      await page.waitForSelector(".bb-more-like .bb-card");
      await page.locator(".bb-more-like").scrollIntoViewIfNeeded();
      await shot(page, `kid-more-like-this-${vp}`);
      await ctx.close();
    }
  }
  await browser.close();
})();
