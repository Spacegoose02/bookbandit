/**
 * Screenshots for listening, Send to Kindle and storyteller (docs/screenshots/).
 *   pnpm --filter @bookbandit/web build
 *   pnpm --filter @bookbandit/web exec vite preview --port 4173 &
 *   node apps/web/scripts/screenshots-listen.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:4173";
const OUT = process.env.OUT || path.resolve(__dirname, "../../../docs/screenshots");
fs.mkdirSync(OUT, { recursive: true });
const DATE = process.env.SHOT_DATE || new Date().toISOString().slice(0, 10);
const DESKTOP = { width: 1280, height: 800 };
const TABLET_PORTRAIT = { width: 800, height: 1280 };

async function session(browser, who, theme, viewport = DESKTOP, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.goto(`${BASE}/?demo=${who}`);
  await page.evaluate(
    ([who, theme, extra]) => {
      const id = who === "kid" ? "u-kid" : "u-adult";
      localStorage.clear();
      localStorage.setItem(`bb-demo-theme-${id}`, theme);
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    },
    [who, theme, extra],
  );
  return { ctx, page };
}

async function shot(page, name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${DATE}-${name}.png`) });
  console.log("saved", name);
}

(async () => {
  const browser = await chromium.launch();

  // Audiobook player
  {
    const { ctx, page } = await session(browser, "adult", "dark");
    await page.goto(`${BASE}/book/b9`);
    await page.waitForSelector(".bb-book");
    await shot(page, "web-book-page-listen-kindle");
    await page.click("text=Send to Kindle");
    await shot(page, "web-send-to-kindle-ask");
    await page.goto(`${BASE}/listen/b9`);
    await page.waitForSelector(".bb-listen-play");
    await page.evaluate(() => {
      const r = document.querySelector(".bb-listen-scrub input");
      r.value = "50";
    });
    await page.click('[aria-label="Play"]');
    await page.waitForTimeout(1200);
    await page.click('[aria-label="Forward 30 seconds"]');
    await page.click("text=Chapters");
    await page.click('button:has-text("Sleep")');
    await page.click('text="15 min"');
    await shot(page, "web-listen-player");
    await page.click('[aria-label="Pause"]');
    await ctx.close();
  }
  {
    const { ctx, page } = await session(browser, "adult", "storm", TABLET_PORTRAIT);
    await page.goto(`${BASE}/listen/b3`);
    await page.waitForSelector(".bb-listen-play");
    await shot(page, "web-listen-tablet-portrait");
    await ctx.close();
  }

  // Grown-up setup
  {
    const { ctx, page } = await session(browser, "adult", "light");
    await page.goto(`${BASE}/settings`);
    await page.waitForSelector(".bb-theme-picker");
    await page.goto(`${BASE}/storyteller/setup`);
    await page.waitForSelector(".bb-story-form");
    await page.waitForTimeout(500);
    await shot(page, "web-storyteller-setup");
    await ctx.close();
  }

  // Toddler storyteller
  for (const [vp, suffix] of [
    [DESKTOP, ""],
    [TABLET_PORTRAIT, "-tablet-portrait"],
  ]) {
    const { ctx, page } = await session(browser, "kid", "dinosaur", vp);
    await page.goto(`${BASE}/`);
    await page.waitForSelector(".bb-story-grid");
    await page.click(".bb-story-cover >> nth=1");
    await shot(page, `web-storyteller-pick${suffix}`);
    if (!suffix) {
      await page.click('[aria-label="Play the story"]');
      await page.waitForSelector(".bb-story-playing");
      await page.waitForTimeout(1500);
      await shot(page, "web-storyteller-playing");
    }
    await ctx.close();
  }
  // Read-aloud fallback (speech stubbed so it holds on the first page)
  {
    const { ctx, page } = await session(browser, "kid", "dinosaur", DESKTOP);
    await page.addInitScript(() => {
      Object.defineProperty(window, "speechSynthesis", { value: { speak() {}, cancel() {}, getVoices: () => [], pause() {}, resume() {} } });
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    });
    await page.goto(`${BASE}/storyteller`);
    await page.waitForSelector(".bb-story-grid");
    await page.click('[aria-label="Six Muddy Ducks"]');
    await page.click('[aria-label="Play the story"]');
    await page.waitForSelector(".bb-story-reader foliate-view");
    await page.waitForTimeout(2500);
    await shot(page, "web-storyteller-read-aloud");
    await ctx.close();
  }

  // Goodnight after the nightly limit
  {
    const night = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(Date.now() - 12 * 3600e3));
    const sessions = ["b15", "b16", "b17"].map((b, i) => ({
      id: `s${i}`, bookId: b, mode: "audio", night, startedAt: Date.now() - 3600e3, lastBeatAt: Date.now(), endedAt: Date.now(), completed: true, listenedMs: 300000,
    }));
    const { ctx, page } = await session(browser, "kid", "dinosaur", DESKTOP, {
      "bb-demo-storyteller-settings": { timeZone: "UTC", nightStartsHour: 12, storiesPerNight: 3 },
      "bb-demo-storyteller-sessions": sessions,
    });
    await page.goto(`${BASE}/storyteller`);
    await page.waitForSelector(".bb-goodnight");
    await shot(page, "web-storyteller-goodnight");
    await ctx.close();
  }

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
