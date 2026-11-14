/**
 * Screenshots for read-aloud, word help, quizzes and the family learning card (docs/screenshots/).
 *   pnpm --filter @bookbandit/web build
 *   pnpm --filter @bookbandit/web exec vite preview --port 4173 &
 *   node apps/web/scripts/screenshots-readaloud.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:4173";
const OUT = process.env.OUT || path.resolve(__dirname, "../../../docs/screenshots");
fs.mkdirSync(OUT, { recursive: true });
const DATE = process.env.SHOT_DATE || new Date().toISOString().slice(0, 10);
const DESKTOP = { width: 1280, height: 800 };
const TABLET = { width: 800, height: 1280 };

async function session(browser, who, theme, viewport = DESKTOP) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.goto(`${BASE}/?demo=${who}`);
  await page.evaluate(
    ([who, theme]) => {
      const id = who === "kid" ? "u-kid" : "u-adult";
      localStorage.clear();
      localStorage.setItem(`bb-demo-theme-${id}`, theme);
    },
    [who, theme],
  );
  // Headless Chromium has no voices: make the device voice "speak" instantly so the player runs.
  await page.addInitScript(() => {
    window.speechSynthesis.speak = (u) => setTimeout(() => u.onstart && u.onstart(new Event("start")), 50);
    window.speechSynthesis.cancel = () => undefined;
  });
  return { ctx, page };
}

async function shot(page, name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${DATE}-${name}.png`) });
  console.log("saved", name);
}

/** The frame showing the book, and the page position of a word in it. */
async function wordBox(page, word) {
  for (let tries = 0; tries < 30; tries++) {
    for (const f of page.frames()) {
      const box = await f
        .evaluate((w) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const i = n.textContent.indexOf(w);
            if (i < 0) continue;
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + w.length);
            const b = r.getBoundingClientRect();
            if (b.width > 0 && b.left >= 0 && b.right <= window.innerWidth) return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
          }
          return null;
        }, word)
        .catch(() => null);
      if (box) {
        const el = await f.frameElement();
        const fb = await el.boundingBox();
        return { x: fb.x + box.x, y: fb.y + box.y };
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`word not found: ${word}`);
}

/** Light up a word the way the narrator does (foliate-js tts.setMark). */
async function highlight(page, block, mark) {
  await page.evaluate(
    async ([block, mark]) => {
      const v = document.querySelector("foliate-view");
      await v.initTTS("word");
      v.tts.start();
      for (let i = 0; i < block; i++) v.tts.next();
      v.tts.setMark(String(mark));
    },
    [block, mark],
  );
}

async function openBook(page, id) {
  await page.goto(`${BASE}/read/${id}`);
  await page.waitForSelector(".bb-ra-fab", { timeout: 15000 });
  await wordBox(page, "Barnaby");
  // Go to the first chapter's text.
  await page.evaluate(async () => {
    const v = document.querySelector("foliate-view");
    const i = v.book.sections.findIndex((s) => /ch1/.test(s.id));
    await v.goTo(i);
  });
  await page.waitForTimeout(800);
}

(async () => {
  const browser = await chromium.launch();

  // Kid reader: read to me with a highlighted word, tap a word, quiz
  for (const [vp, suffix] of [
    [TABLET, "-tablet"],
    [DESKTOP, ""],
  ]) {
    const { ctx, page } = await session(browser, "kid", "dinosaur", vp);
    await openBook(page, "b1");
    await shot(page, `readaloud-kid-read-to-me${suffix}`);
    await page.click(".bb-ra-fab");
    await page.waitForSelector(".bb-ra-bar");
    await page.waitForTimeout(400);
    await page.click('[aria-label="Stop reading"]');
    await page.click(".bb-ra-fab");
    await page.waitForTimeout(300);
    await page.click('[aria-label="Pause"]').catch(() => undefined);
    await highlight(page, 2, 9);
    await shot(page, `readaloud-kid-highlight${suffix}`);

    const box = await wordBox(page, "attic");
    await page.mouse.click(box.x, box.y);
    await page.waitForSelector(".bb-ra-meaning");
    await shot(page, `readaloud-kid-word-help${suffix}`);
    await page.click('.bb-ra-word [aria-label="Close"]');

    await page.click('[aria-label="Quiz me on this chapter"]');
    await page.waitForSelector(".bb-ra-quiz");
    await shot(page, `readaloud-kid-quiz${suffix}`);
    await page.click(".bb-ra-choice >> nth=0");
    await page.waitForSelector(".bb-ra-cheer");
    await shot(page, `readaloud-kid-quiz-cheer${suffix}`);
    await ctx.close();
  }

  // Grown-up reader: read aloud bar and double-click word help
  {
    const { ctx, page } = await session(browser, "adult", "dark");
    await openBook(page, "b1");
    await page.click(".bb-ra-fab");
    await page.waitForSelector(".bb-ra-bar");
    await page.click('[aria-label="Pause"]').catch(() => undefined);
    await highlight(page, 3, 4);
    const box = await wordBox(page, "spiral");
    await page.mouse.dblclick(box.x, box.y);
    await page.waitForSelector(".bb-ra-meaning");
    await shot(page, "readaloud-reader-word-help");
    await ctx.close();
  }

  // Family dashboard learning card
  for (const [vp, suffix] of [
    [DESKTOP, ""],
    [TABLET, "-tablet"],
  ]) {
    const { ctx, page } = await session(browser, "admin", "light", vp);
    await page.goto(`${BASE}/family/kids/u-kid`);
    await page.waitForSelector(".bb-ra-learning .bb-ra-quizlog");
    await page.click(".bb-ra-quizlog summary >> nth=1");
    await page.evaluate(() => {
      document.querySelector(".bb-ra-learning").scrollIntoView({ block: "start" });
      window.scrollBy(0, -90);
    });
    await shot(page, `readaloud-family-learning${suffix}`);
    await ctx.close();
  }

  // Admin settings
  {
    const { ctx, page } = await session(browser, "admin", "light");
    await page.goto(`${BASE}/readaloud/settings`);
    await page.waitForSelector(".bb-ra-settings input");
    await page.click("text=Save and test");
    await page.waitForSelector("[role=status].bb-ra-ok");
    await shot(page, "readaloud-admin-settings");
    await ctx.close();
  }

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
