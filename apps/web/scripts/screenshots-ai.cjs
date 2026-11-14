/**
 * Captures Barnaby AI screenshots into docs/screenshots/ from the demo build.
 *   pnpm --filter @bookbandit/web build && pnpm --filter @bookbandit/web preview --port 4173 &
 *   node apps/web/scripts/screenshots-ai.cjs
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

async function shot(page, name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${DATE}-ai-${name}.png`) });
  console.log("saved", name);
}

async function ask(page, text, { web = false } = {}) {
  if (web) await page.check(".bb-chat-web input");
  await page.fill(".bb-chat-input textarea", text);
  await page.click(".bb-chat-send");
  await page.waitForSelector(".bb-chat-row .bb-dots", { state: "detached" });
}

(async () => {
  const browser = await chromium.launch();
  for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
    {
      const { ctx, page } = await session(browser, "adult", "dark", viewport);
      await page.click(".bb-launcher", { force: true });
      await shot(page, `panel-hello-${vp}`);
      await ask(page, "Anything about the sea?");
      await shot(page, `panel-library-${vp}`);
      await ask(page, "What is a volcano?", { web: true });
      await shot(page, `panel-web-${vp}`);
      await page.goto(`${BASE}/read/b9`);
      await page.waitForSelector(".bb-foliate");
      await page.waitForTimeout(1200);
      await page.click(".bb-launcher", { force: true });
      await ask(page, "Recap what's happened so far");
      await shot(page, `reader-book-chat-${vp}`);
      await page.goto(`${BASE}/barnaby`);
      await page.waitForSelector(".bb-chat");
      await ask(page, "Something cozy for a rainy evening");
      await shot(page, `page-${vp}`);
      await page.goto(`${BASE}/barnaby/family`);
      await page.waitForSelector(".bb-family-transcript .bb-chat");
      await page.click(".bb-conv-list-plain li:nth-child(2) button");
      await shot(page, `family-log-${vp}`);
      await page.goto(`${BASE}/barnaby/settings`);
      await page.waitForSelector(".bb-provider");
      await shot(page, `settings-${vp}`);
      await ctx.close();
    }
    {
      const { ctx, page } = await session(browser, "kid", "dinosaur", viewport);
      await shot(page, `kid-home-launcher-${vp}`);
      await page.click(".bb-launcher", { force: true });
      await shot(page, `kid-panel-hello-${vp}`);
      await ask(page, "Tell me a dinosaur fact 🦖");
      await shot(page, `kid-panel-answer-${vp}`);
      await ctx.close();
    }
  }
  await browser.close();
})();
