/**
 * Screenshots for the kids workstream (docs/screenshots/*-kids-*.png): kid home with goal ring
 * and a new badge, sticker book, bedtime screen, reading help in the reader, the parent's
 * goals/bedtime card, and a theme sheet of the wave 2 pages in every theme.
 *   pnpm --filter @bookbandit/web build
 *   pnpm --filter @bookbandit/web preview --port 4173 &
 *   node apps/web/scripts/screenshots-kids.cjs
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
const THEMES = ["dark", "light", "nuclear", "retro", "pink", "school", "gaming", "dinosaur", "storm", "contrast"];

async function open(browser, who, theme, viewport, url = "/") {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/?demo=${who}`);
  await page.evaluate(
    ([who, theme]) => {
      const id = who === "kid" ? "u-kid" : "u-adult";
      localStorage.setItem(`bb-demo-theme-${id}`, theme);
      // The demo kid is a storyteller profile by default; show the reading kid's home instead.
      localStorage.setItem("bb-demo-storyteller-settings", JSON.stringify({ enabled: false }));
      localStorage.setItem("bb-storyteller-on-u-kid", "0");
      const progress = (bookId, percent) =>
        localStorage.setItem(
          `bb-demo-progress-${id}-${bookId}`,
          JSON.stringify({ bookId, locator: { kind: "epub", cfi: "", percent }, percent, finished: false, deviceName: "Tablet", clientUpdatedAt: Date.parse("2026-11-13T19:00:00Z"), serverUpdatedAt: Date.parse("2026-11-13T19:00:01Z") }),
        );
      if (who === "kid") (progress("b1", 0.6), progress("b3", 0.2));
    },
    [who, theme],
  );
  await page.goto(`${BASE}${url}`);
  await page.waitForSelector(".bb-app, .bb-reader, .bb-bedtime");
  await page.waitForTimeout(700);
  return { ctx, page };
}

async function shot(page, name, fullPage = false) {
  if (fullPage) await page.addStyleTag({ content: ".bb-topbar { position: static !important; }" });
  await page.waitForTimeout(400);
  const file = path.join(OUT, `${DATE}-kids-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log("saved", path.basename(file));
  return file;
}

(async () => {
  const browser = await chromium.launch();

  // Kid home: goal ring, new badge, keep reading, new books, badges, age rows.
  for (const [vp, suffix, theme] of [
    [DESKTOP, "", "dinosaur"],
    [TABLET, "-tablet", "pink"],
  ]) {
    const { ctx, page } = await open(browser, "kid", theme, vp);
    await shot(page, `home${suffix}`, true);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, "kid", "gaming", DESKTOP, "/stickers");
    await shot(page, "sticker-book", true);
    await ctx.close();
  }
  for (const [vp, suffix] of [
    [DESKTOP, ""],
    [TABLET, "-tablet"],
  ]) {
    const { ctx, page } = await open(browser, "kid", "storm", vp, "/?bedtime");
    await page.waitForSelector(".bb-bedtime");
    await shot(page, `bedtime${suffix}`);
    await ctx.close();
  }
  {
    // Reading help in the kid reader, with dyslexia-friendly letters on.
    const { ctx, page } = await open(browser, "kid", "school", DESKTOP, "/read/b1");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /settings|text/i }).first().click().catch(() => undefined);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /Dyslexia-friendly/ }).click().catch(() => undefined);
    await page.waitForTimeout(1200);
    await shot(page, "reader-reading-help");
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, "kid", "contrast", DESKTOP, "/settings");
    await shot(page, "settings-high-contrast", true);
    await ctx.close();
  }
  // Parent: goals, badges and bedtime card.
  for (const [vp, suffix] of [
    [DESKTOP, ""],
    [TABLET, "-tablet"],
  ]) {
    const { ctx, page } = await open(browser, "adult", "light", vp, "/family/kids/u-kid");
    await page.waitForSelector(".bb-kid-rewards-card");
    await page.getByLabel("Turn on reading bedtime").check();
    await page.getByLabel("Later on Friday and Saturday").check();
    await page.addStyleTag({ content: ".bb-topbar, .bb-launcher { position: static !important; }" });
    await page.locator(".bb-kid-rewards-card").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const card = page.locator(".bb-kid-rewards-card");
    const file = path.join(OUT, `${DATE}-kids-family-goals${suffix}.png`);
    await card.screenshot({ path: file });
    console.log("saved", path.basename(file));
    await ctx.close();
  }

  // Theme sheet: wave 2 pages in every theme, as one image per page.
  const PAGES = [
    ["discover", "/discover"],
    ["requests", "/requests"],
    ["barnaby", "/barnaby"],
    ["listen", "/listen/b9"],
    ["admin", "/admin"],
  ];
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "bb-themes-"));
  for (const [name, url] of PAGES) {
    const tiles = [];
    for (const theme of THEMES) {
      const { ctx, page } = await open(browser, "adult", theme, DESKTOP, url);
      const f = path.join(tmp, `${name}-${theme}.png`);
      await page.screenshot({ path: f });
      tiles.push([theme, fs.readFileSync(f).toString("base64")]);
      await ctx.close();
    }
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.setContent(
      `<body style="margin:0;background:#222;font:600 16px system-ui;color:#fff"><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:8px">${tiles
        .map(([t, b64]) => `<figure style="margin:0"><img style="width:100%;display:block" src="data:image/png;base64,${b64}"><figcaption style="padding:4px 2px">${t}</figcaption></figure>`)
        .join("")}</div></body>`,
    );
    await page.waitForTimeout(300);
    const file = path.join(OUT, `${DATE}-kids-themes-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log("saved", path.basename(file));
    await ctx.close();
  }

  await browser.close();
})();
