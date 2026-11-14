import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { readingProgress, readingSessions } from "../src/db/schema.js";
import { storytellerSettings } from "../src/storyteller/schema.js";
import { family, type Family } from "./helpers.js";

// Wednesday 2026-11-11, 16:00 UTC.
let clock = Date.parse("2026-11-11T16:00:00Z");
let f: Family;

async function setup() {
  clock = Date.parse("2026-11-11T16:00:00Z");
  f = await family({ rewards: { now: () => clock } });
}
afterEach(() => f.close());

type Who = "kid" | "parent" | "adult" | "admin";
const get = (who: Who, url: string) => f.app.inject({ method: "GET", url, headers: f.as(who) });
const put = (who: Who, url: string, payload: object) => f.app.inject({ method: "PUT", url, headers: f.as(who), payload });
const post = (who: Who, url: string, payload: object) => f.app.inject({ method: "POST", url, headers: f.as(who), payload });

function readOn(userId: string, bookId: string, iso: string, seconds: number) {
  const t = Date.parse(iso);
  f.db.insert(readingSessions).values({ id: randomUUID(), userId, bookId, startedAt: t, lastBeatAt: t + seconds * 1000, seconds }).run();
}
function finish(userId: string, bookId: string, at = clock) {
  f.db
    .insert(readingProgress)
    .values({ userId, bookId, locator: { kind: "epub", cfi: "x" }, percent: 1, finished: true, clientUpdatedAt: at, serverUpdatedAt: at })
    .run();
}

const goal = { minutesPerDay: 20, booksPerMonth: 2, timeZone: "UTC" };
const bedtime = { enabled: true, startMinute: 20 * 60, endMinute: 7 * 60, weekendStartMinute: null, timeZone: "UTC" };

describe("reading goals", () => {
  it("only a linked parent or admin sets a kid's goal; never the kid", async () => {
    await setup();
    const { kid, otherKid } = f.ids;
    expect((await put("kid", `/api/rewards/kids/${kid}/goal`, goal)).statusCode).toBe(403);
    expect((await put("kid", `/api/rewards/kids/me/goal`, goal)).statusCode).toBe(403);
    expect((await put("adult", `/api/rewards/kids/${kid}/goal`, goal)).statusCode).toBe(404);
    // Dad isn't linked to Leo.
    expect((await put("parent", `/api/rewards/kids/${otherKid}/goal`, goal)).statusCode).toBe(404);
    const ok = await put("parent", `/api/rewards/kids/${kid}/goal`, goal);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().goal).toEqual(goal);
    expect((await put("admin", `/api/rewards/kids/${otherKid}/goal`, goal)).statusCode).toBe(200);
    expect((await put("parent", `/api/rewards/kids/${kid}/goal`, { ...goal, minutesPerDay: 1 })).statusCode).toBe(400);

    const settings = await get("parent", `/api/rewards/kids/${kid}/settings`);
    expect(settings.json()).toMatchObject({ canEdit: true, goal });
    expect((await get("kid", `/api/rewards/kids/me/settings`)).json().canEdit).toBe(false);
  });

  it("a kid earns a badge and a sticker for a goal a parent set, and sees it once", async () => {
    await setup();
    const { kid } = f.ids;
    const book = f.book("Dinosaur Picnic", "kids");
    await put("parent", `/api/rewards/kids/${kid}/goal`, goal);
    readOn(kid, book, "2026-11-11T09:00:00Z", 25 * 60);

    const res = await get("kid", "/api/rewards/me");
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.today).toMatchObject({ date: "2026-11-11", readSeconds: 1500, goalSeconds: 1200, met: true });
    expect(s.badges.find((b: { id: string }) => b.id === "goal_first").earnedAt).not.toBeNull();
    expect(s.stickers.map((x: { reason: string; key: string }) => [x.reason, x.key])).toContainEqual(["goal_day", "2026-11-11"]);
    expect(s.fresh.map((x: { name: string }) => x.name)).toContain("Bullseye");

    // Mark seen: the celebration doesn't come back.
    const seen = await post("kid", "/api/rewards/me/seen", { ids: s.fresh.map((x: { id: string }) => x.id) });
    expect(seen.json().marked).toBe(s.fresh.length);
    expect((await get("kid", "/api/rewards/me")).json().fresh).toEqual([]);

    // The parent sees the same badge on their card, without the kid's celebrations.
    const p = (await get("parent", `/api/rewards/${kid}`)).json();
    expect(p.badges.find((b: { id: string }) => b.id === "goal_first").earnedAt).not.toBeNull();
    expect(p.fresh).toEqual([]);
  });

  it("doesn't backfill goal stickers from before the goal was set", async () => {
    await setup();
    const { kid } = f.ids;
    const book = f.book("Dinosaur Picnic", "kids");
    readOn(kid, book, "2026-11-09T09:00:00Z", 40 * 60);
    await put("parent", `/api/rewards/kids/${kid}/goal`, goal);
    const s = (await get("kid", "/api/rewards/me")).json();
    expect(s.stickers.filter((x: { reason: string }) => x.reason === "goal_day")).toEqual([]);
  });

  it("counts finished books toward the month goal and book badges", async () => {
    await setup();
    const { kid } = f.ids;
    await put("parent", `/api/rewards/kids/${kid}/goal`, goal);
    finish(kid, f.book("One", "kids"));
    finish(kid, f.book("Two", "kids"));
    const s = (await get("kid", "/api/rewards/me")).json();
    expect(s.booksFinished).toBe(2);
    expect(s.month).toMatchObject({ month: "2026-11", books: 2, goalBooks: 2, met: true });
    const earned = s.badges.filter((b: { earnedAt: number | null }) => b.earnedAt).map((b: { id: string }) => b.id);
    expect(earned).toEqual(expect.arrayContaining(["first_book", "goal_month"]));
    expect(earned).not.toContain("books_5");
  });

  it("awards streak badges for days in a row", async () => {
    await setup();
    const { kid } = f.ids;
    const book = f.book("Dinosaur Picnic", "kids");
    for (const d of ["09", "10", "11"]) readOn(kid, book, `2026-11-${d}T09:00:00Z`, 60);
    const s = (await get("kid", "/api/rewards/me")).json();
    expect(s.streakDays).toBe(3);
    expect(s.badges.find((b: { id: string }) => b.id === "streak_3").earnedAt).not.toBeNull();
    expect(s.badges.find((b: { id: string }) => b.id === "streak_7").earnedAt).toBeNull();
  });

  it("a kid can't read another kid's rewards", async () => {
    await setup();
    expect((await get("kid", `/api/rewards/${f.ids.otherKid}`)).statusCode).toBe(404);
    expect((await get("adult", `/api/rewards/${f.ids.kid}`)).statusCode).toBe(404);
  });
});

describe("content lock on stickers", () => {
  it("a book sticker never names a book the viewer can't see", async () => {
    await setup();
    const { kid } = f.ids;
    // A book the kid finished before an admin re-rated it as adult.
    const book = f.book("Was For Kids", "kids");
    finish(kid, book);
    expect((await get("kid", "/api/rewards/me")).json().stickers[0].book.title).toBe("Was For Kids");
    f.db.update((await import("../src/db/schema.js")).books).set({ rating: "adult" }).run();
    const s = (await get("kid", "/api/rewards/me")).json();
    expect(s.stickers[0].reason).toBe("book");
    expect(s.stickers[0].book).toBeNull();
    expect(JSON.stringify(s)).not.toContain("Was For Kids");
  });
});

describe("reading bedtime", () => {
  it("is set by a parent and enforced on the server for book files and reading time", async () => {
    await setup();
    const { kid } = f.ids;
    const book = f.book("Dinosaur Picnic", "kids");
    expect((await put("kid", `/api/rewards/kids/me/bedtime`, bedtime)).statusCode).toBe(403);
    expect((await put("parent", `/api/rewards/kids/${kid}/bedtime`, { ...bedtime, startMinute: 9 * 60 })).statusCode).toBe(400);
    const saved = await put("parent", `/api/rewards/kids/${kid}/bedtime`, bedtime);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().bedtimeNow.active).toBe(false);

    const beat = () => post("kid", "/api/reading/heartbeat", { sessionId: randomUUID(), bookId: book, seconds: 30 });
    expect((await beat()).statusCode).toBe(201);

    // 21:00 UTC: bedtime.
    clock = Date.parse("2026-11-11T21:00:00Z");
    const blocked = await beat();
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ bedtime: true, endsAt: Date.parse("2026-11-12T07:00:00Z") });
    const file = await get("kid", `/api/books/${book}/files/whatever`);
    expect(file.statusCode).toBe(403);
    expect(file.json().bedtime).toBe(true);
    expect((await get("kid", "/api/rewards/me/bedtime")).json()).toMatchObject({ active: true });

    // Grown-ups aren't affected.
    expect((await post("parent", "/api/reading/heartbeat", { sessionId: randomUUID(), bookId: book, seconds: 30 })).statusCode).toBe(201);

    // Morning: open again.
    clock = Date.parse("2026-11-12T07:00:00Z");
    expect((await beat()).statusCode).toBe(201);
  });

  it("leaves storyteller audio to storyteller's own limits", async () => {
    await setup();
    const { kid } = f.ids;
    const book = f.book("Goodnight Moon-ish", "kids", { absItemId: "abs-1" });
    await put("parent", `/api/rewards/kids/${kid}/bedtime`, bedtime);
    clock = Date.parse("2026-11-11T21:00:00Z");
    const audio = () => get("kid", `/api/books/${book}/audio/tracks/0`);
    expect((await audio()).json().bedtime).toBe(true);
    f.db
      .insert(storytellerSettings)
      .values({ kidId: kid, enabled: true, readAloud: true, timeZone: "UTC", nightStartsHour: 12, updatedAt: clock })
      .run();
    expect((await audio()).json().bedtime).toBeUndefined();
  });
});
