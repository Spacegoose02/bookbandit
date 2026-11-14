import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readingProgress, readingSessions } from "../src/db/schema.js";
import { addDays, startOfDay } from "../src/family-apps/den-duty.js";
import { recipeText, sortBlocks } from "../src/family-apps/kitchen.js";
import { family, type Family } from "./helpers.js";

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: any;
}

/** A stand-in for Den Duty and Nighttime Ninja. */
function fakeApps() {
  const calls: Call[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const auth = new Headers(init.headers).get("authorization");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", url: url.pathname, auth, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.host === "chores.test") {
      if (auth !== "Bearer ddt_control") return json({ error: "Unauthorized" }, 401);
      if (url.pathname === "/api/v1/homes/h1") return json({ id: "h1", name: "Den", timezone: "UTC", today });
      if (url.pathname === "/api/v1/homes/h1/kids") return json([{ id: "dk1", name: "Emma", avatar: "fox", color: "#f80" }]);
      if (url.pathname === "/api/v1/homes/h1/kids/dk1/habits") return json([{ id: "hab1", title: "Reading", icon: "📚", minutes: 20 }]);
      if (url.pathname === "/api/v1/homes/h1/reading/report")
        return json({ ok: true, kids: body.kids.map((k: any) => ({ kidId: k.kidId, minutes: k.minutes, habitPaid: 3, finishedPaid: 0 })) });
    }
    if (url.host === "kitchen.test") {
      if (auth !== "Bearer nnk_kitchen") return json({ error: "Unauthorized" }, 401);
      if (url.pathname === "/api/homes/k1/recipes/import")
        return json({ recipes: [{ title: "parsed", sourceUrl: null, tags: ["dinner"], ingredients: [{ name: "flour" }, { name: "eggs" }], instructions: ["Mix", "Bake"] }] });
      if (url.pathname === "/api/homes/k1/recipes") return json({ id: "r42" });
      if (url.pathname === "/api/homes/k1/ha/summary") return json({ ok: 1 });
    }
    return json({ error: "Not found" }, 404);
  };
  return { calls, fetchImpl, today };
}

let f: Family;
let fake: ReturnType<typeof fakeApps>;

beforeEach(async () => {
  fake = fakeApps();
  f = await family({ familyApps: { fetchImpl: fake.fetchImpl, reportEveryMs: 0 } });
});
afterEach(() => f.close());

const req = (who: "admin" | "parent" | "adult" | "kid", method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object) =>
  f.app.inject({ method, url, headers: f.as(who), payload });

const linkDen = (kids: object[] = []) =>
  req("admin", "PUT", "/api/admin/family-apps/den-duty", { url: "http://chores.test/", homeId: "h1", token: "ddt_control", kids });
const linkKitchen = () => req("admin", "PUT", "/api/admin/family-apps/kitchen", { url: "http://kitchen.test", homeId: "k1", token: "nnk_kitchen" });

describe("family app settings", () => {
  it("are admin-only", async () => {
    for (const who of ["parent", "adult", "kid"] as const) {
      expect((await req(who, "GET", "/api/admin/family-apps")).statusCode).toBe(403);
      expect((await req(who, "PUT", "/api/admin/family-apps/kitchen", { url: "http://kitchen.test", homeId: "k1", token: "x" })).statusCode).toBe(403);
    }
  });

  it("seal tokens and never send them back", async () => {
    const res = await linkDen([{ userId: f.ids.kid, kidId: "dk1", habitId: "hab1" }]);
    expect(res.statusCode).toBe(200);
    expect(res.json().denDuty).toMatchObject({ url: "http://chores.test", homeId: "h1", hasToken: true, enabled: true });
    expect(JSON.stringify(res.json())).not.toContain("ddt_control");
    const all = await req("admin", "GET", "/api/admin/family-apps");
    expect(JSON.stringify(all.json())).not.toContain("ddt_control");
    expect(all.json().kids.map((k: any) => k.id).sort()).toEqual([f.ids.kid, f.ids.otherKid].sort());
    // Saving again without a token keeps the stored one.
    const again = await req("admin", "PUT", "/api/admin/family-apps/den-duty", { url: "http://chores.test", homeId: "h1", kids: [] });
    expect(again.json().denDuty.hasToken).toBe(true);
  });

  it("need a token the first time and only match kids from this household", async () => {
    expect((await req("admin", "PUT", "/api/admin/family-apps/den-duty", { url: "http://chores.test", homeId: "h1" })).statusCode).toBe(400);
    expect((await linkDen([{ userId: f.ids.parent, kidId: "dk1", habitId: "hab1" }])).statusCode).toBe(400);
    expect((await req("admin", "PUT", "/api/admin/family-apps/kitchen", { url: "ftp://kitchen.test", homeId: "k1", token: "t" })).statusCode).toBe(400);
  });

  it("tell a matched kid that reading counts for Den Duty, and nobody else", async () => {
    await linkDen([{ userId: f.ids.otherKid, kidId: "dk2", habitId: "hab2" }]);
    expect((await req("kid", "GET", "/api/family-apps")).json()).toEqual({ kitchen: false, denDuty: false });
    await linkDen([{ userId: f.ids.kid, kidId: "dk1", habitId: "hab1" }]);
    expect((await req("kid", "GET", "/api/family-apps")).json()).toEqual({ kitchen: false, denDuty: true });
    expect((await req("parent", "GET", "/api/family-apps")).json()).toEqual({ kitchen: false, denDuty: false });
  });

  it("list Den Duty's kids with their habits", async () => {
    await linkDen();
    const res = await req("admin", "GET", "/api/admin/family-apps/den-duty/kids");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ home: { name: "Den" }, kids: [{ id: "dk1", habits: [{ id: "hab1", title: "Reading" }] }], habitsMissing: false });
  });

  it("report a bad token as a 502 with a plain message", async () => {
    await req("admin", "PUT", "/api/admin/family-apps/den-duty", { url: "http://chores.test", homeId: "h1", token: "wrong" });
    const res = await req("admin", "GET", "/api/admin/family-apps/den-duty/kids");
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/didn't accept the token/);
  });

  it("check the kitchen link and unlink", async () => {
    await linkKitchen();
    expect((await req("admin", "POST", "/api/admin/family-apps/kitchen/check")).json()).toEqual({ ok: true });
    expect((await req("admin", "DELETE", "/api/admin/family-apps/kitchen")).json().kitchen).toBeNull();
  });
});

describe("reading report to Den Duty", () => {
  it("sends today's minutes and finished books the kid may see, once until something changes", async () => {
    const kidsBook = f.book("Dinosaur Picnic", "kids");
    const adultBook = f.book("Night Thriller", "adult");
    const now = Date.now();
    f.db.insert(readingSessions).values({ id: randomUUID(), userId: f.ids.kid, bookId: kidsBook, kind: "read", startedAt: now - 1000, lastBeatAt: now, seconds: 25 * 60 + 30 }).run();
    f.db.insert(readingSessions).values({ id: randomUUID(), userId: f.ids.kid, bookId: kidsBook, kind: "listen", startedAt: now - 500, lastBeatAt: now, seconds: 5 * 60 }).run();
    // The other kid isn't matched, so their reading never leaves.
    f.db.insert(readingSessions).values({ id: randomUUID(), userId: f.ids.otherKid, bookId: kidsBook, kind: "read", startedAt: now, lastBeatAt: now, seconds: 600 }).run();
    for (const bookId of [kidsBook, adultBook]) {
      f.db.insert(readingProgress).values({ userId: f.ids.kid, bookId, locator: { kind: "epub", cfi: "x", percent: 1 } as any, percent: 1, finished: true, clientUpdatedAt: now, serverUpdatedAt: now }).run();
    }
    await linkDen([{ userId: f.ids.kid, kidId: "dk1", habitId: "hab1" }]);

    await f.app.familyApps.reportAll();
    const reports = fake.calls.filter((c) => c.url.endsWith("/reading/report"));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.auth).toBe("Bearer ddt_control");
    const todayRow = reports[0]!.body.kids.find((k: any) => k.date === fake.today);
    expect(todayRow).toEqual({ kidId: "dk1", habitId: "hab1", date: fake.today, minutes: 30, finished: [{ id: kidsBook, title: "Dinosaur Picnic" }] });
    expect(JSON.stringify(reports[0]!.body)).not.toContain("Night Thriller");
    expect(reports[0]!.body.kids.find((k: any) => k.date === addDays(fake.today, -1))).toMatchObject({ minutes: 0, finished: [] });

    // Nothing changed: nothing sent.
    await f.app.familyApps.reportAll();
    expect(fake.calls.filter((c) => c.url.endsWith("/reading/report"))).toHaveLength(1);

    // More reading: only today goes again.
    f.db.insert(readingSessions).values({ id: randomUUID(), userId: f.ids.kid, bookId: kidsBook, kind: "read", startedAt: now, lastBeatAt: now, seconds: 120 }).run();
    await f.app.familyApps.reportAll();
    const third = fake.calls.filter((c) => c.url.endsWith("/reading/report"))[1]!;
    expect(third.body.kids).toHaveLength(1);
    expect(third.body.kids[0].minutes).toBe(32);

    const status = (await req("admin", "GET", "/api/admin/family-apps")).json().lastReport;
    expect(status).toMatchObject({ ok: true, sent: 1 });
  });

  it("can be sent now by an admin, and not by anyone else", async () => {
    await linkDen([{ userId: f.ids.kid, kidId: "dk1", habitId: "hab1" }]);
    expect((await req("parent", "POST", "/api/admin/family-apps/den-duty/report")).statusCode).toBe(403);
    const res = await req("admin", "POST", "/api/admin/family-apps/den-duty/report");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, sent: 2 });
  });

  it("does nothing while the link is switched off", async () => {
    await req("admin", "PUT", "/api/admin/family-apps/den-duty", {
      url: "http://chores.test", homeId: "h1", token: "ddt_control", enabled: false, kids: [{ userId: f.ids.kid, kidId: "dk1", habitId: "hab1" }],
    });
    await f.app.familyApps.reportAll();
    expect(fake.calls).toHaveLength(0);
  });
});

describe("day boundaries", () => {
  it("start at local midnight in the home's time zone", () => {
    expect(startOfDay("2026-07-01", "UTC")).toBe(Date.UTC(2026, 6, 1));
    expect(startOfDay("2026-07-01", "America/New_York")).toBe(Date.UTC(2026, 6, 1, 4));
    expect(startOfDay("2026-12-01", "America/New_York")).toBe(Date.UTC(2026, 11, 1, 5));
    // The day DST starts in New York.
    expect(startOfDay("2026-03-08", "America/New_York")).toBe(Date.UTC(2026, 2, 8, 5));
    expect(startOfDay("2026-07-01", "Not/AZone")).toBe(Date.UTC(2026, 6, 1));
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("Send to kitchen", () => {
  const blocks = [
    { type: "heading", text: "Pancakes" },
    { type: "text", text: "Serves 4" },
    { type: "text", text: "Fluffy weekend pancakes." },
    { type: "item", list: "ul", text: "2 cups flour" },
    { type: "item", list: "ul", text: "2 eggs" },
    { type: "text", text: "Whisk everything together until smooth, then rest for ten minutes." },
    { type: "text", text: "Cook on a hot griddle until bubbles form, then flip." },
  ];

  it("sends a recipe a grown-up can see, with a link back and no public sharing", async () => {
    const book = f.book("Weekend Cooking", "kids");
    await linkKitchen();
    expect((await req("parent", "GET", "/api/family-apps")).json()).toEqual({ kitchen: true, denDuty: false });
    const res = await f.app.inject({
      method: "POST",
      url: "/api/family-apps/kitchen/recipes",
      headers: { ...f.as("parent"), origin: "https://books.example.com" },
      payload: { bookId: book, title: "Pancakes", href: "ch03.xhtml#pancakes", blocks },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "r42", url: "http://kitchen.test/recipes/r42", title: "Pancakes", ingredients: 2, steps: 2 });
    const imp = fake.calls.find((c) => c.url.endsWith("/recipes/import"))!;
    expect(imp.body.text).toBe(
      "Pancakes\nServes 4\nFluffy weekend pancakes.\n\nIngredients\n2 cups flour\n2 eggs\n\nMethod\nWhisk everything together until smooth, then rest for ten minutes.\nCook on a hot griddle until bubbles form, then flip.",
    );
    const save = fake.calls.find((c) => c.url === "/api/homes/k1/recipes")!;
    expect(save.auth).toBe("Bearer nnk_kitchen");
    expect(save.body).toMatchObject({
      title: "Pancakes",
      noPublicShare: true,
      sourceUrl: `https://books.example.com/cook/${book}?at=${encodeURIComponent("ch03.xhtml#pancakes")}`,
      tags: ["dinner", "Weekend Cooking"],
    });
  });

  it("uses the admin's public address for the link back when set", async () => {
    const book = f.book("Weekend Cooking", "kids");
    await linkKitchen();
    await req("admin", "PUT", "/api/admin/family-apps/public-url", { publicUrl: "https://bookbandit.home/" });
    await req("parent", "POST", "/api/family-apps/kitchen/recipes", { bookId: book, title: "Pancakes", blocks });
    expect(fake.calls.find((c) => c.url === "/api/homes/k1/recipes")!.body.sourceUrl).toBe(`https://bookbandit.home/cook/${book}`);
  });

  it("is a 404 for a book the grown-up can't see, and closed to kids", async () => {
    const locked = f.book("Explicit Cooking", "explicit");
    const kidsBook = f.book("Kid Snacks", "kids");
    await linkKitchen();
    expect((await req("parent", "POST", "/api/family-apps/kitchen/recipes", { bookId: locked, title: "X", blocks })).statusCode).toBe(404);
    expect((await req("kid", "POST", "/api/family-apps/kitchen/recipes", { bookId: kidsBook, title: "X", blocks })).statusCode).toBe(403);
    expect((await req("kid", "GET", "/api/family-apps")).json()).toEqual({ kitchen: false, denDuty: false });
    expect(fake.calls).toHaveLength(0);
  });

  it("says so when nothing is linked or nothing looks like a recipe", async () => {
    const book = f.book("Weekend Cooking", "kids");
    expect((await req("parent", "POST", "/api/family-apps/kitchen/recipes", { bookId: book, title: "X", blocks })).statusCode).toBe(409);
    await linkKitchen();
    const res = await req("parent", "POST", "/api/family-apps/kitchen/recipes", { bookId: book, title: "Intro", blocks: [{ type: "text", text: "A story about my grandmother's kitchen." }] });
    expect(res.statusCode).toBe(422);
  });
});

describe("sorting recipe blocks", () => {
  it("follows the book's own Ingredients and Method headings", () => {
    const r = sortBlocks("Soup", [
      { type: "heading", text: "Soup" },
      { type: "text", text: "A warming soup." },
      { type: "heading", text: "Ingredients" },
      { type: "text", text: "Salt to taste" },
      { type: "text", text: "1 onion" },
      { type: "heading", text: "Method" },
      { type: "item", list: "ol", text: "Chop the onion." },
      { type: "item", list: "ol", text: "Simmer." },
    ]);
    expect(r).toEqual({ title: "Soup", head: ["A warming soup."], ingredients: ["Salt to taste", "1 onion"], steps: ["Chop the onion.", "Simmer."] });
  });

  it("keeps sub-lists like 'For the sauce' and strips step numbers", () => {
    const r = sortBlocks("Pasta", [
      { type: "heading", text: "For the sauce:" },
      { type: "text", text: "2 tomatoes" },
      { type: "heading", text: "Directions" },
      { type: "text", text: "1. Boil the pasta." },
    ]);
    expect(recipeText(r)).toBe("Pasta\n\nIngredients\nFor the sauce:\n2 tomatoes\n\nMethod\nBoil the pasta.");
  });

  it("guesses from shape without headings: amounts are ingredients, ordered lists are steps", () => {
    const r = sortBlocks("Toast", [
      { type: "text", text: "½ loaf bread" },
      { type: "text", text: "a pinch of salt" },
      { type: "item", list: "ol", text: "Toast the bread." },
    ]);
    expect(r.ingredients).toEqual(["½ loaf bread", "a pinch of salt"]);
    expect(r.steps).toEqual(["Toast the bread."]);
  });
});
