import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { books, readingSessions } from "../src/db/schema.js";
import { family, type Family } from "./helpers.js";

let f: Family;
let kidsBook: string;
let adultBook: string;

beforeEach(async () => {
  f = await family();
  kidsBook = f.book("Dinosaur Picnic", "kids");
  adultBook = f.book("Night Thriller", "adult");
});
afterEach(() => f.close());

const beat = (who: "kid" | "parent" | "adult" | "admin", body: object) =>
  f.app.inject({ method: "POST", url: "/api/reading/heartbeat", headers: f.as(who), payload: body });
const stats = (who: "kid" | "parent" | "adult" | "admin", qs = "") =>
  f.app.inject({ method: "GET", url: `/api/reading/stats${qs}`, headers: f.as(who) });

describe("POST /api/reading/heartbeat", () => {
  it("starts a session and caps later beats by wall-clock time", async () => {
    const sessionId = randomUUID();
    const first = await beat("kid", { sessionId, bookId: kidsBook, seconds: 60 });
    expect(first.statusCode).toBe(201);
    expect(first.json().seconds).toBe(60);

    // Immediately claiming another 5 minutes only counts the slack.
    const second = await beat("kid", { sessionId, bookId: kidsBook, seconds: 300 });
    expect(second.statusCode).toBe(200);
    expect(second.json().counted).toBeLessThanOrEqual(6);

    // After a real minute passes, a 60-second beat counts in full.
    const row = f.db.select().from(readingSessions).where(eq(readingSessions.id, sessionId)).get()!;
    f.db.update(readingSessions).set({ lastBeatAt: row.lastBeatAt - 60_000 }).where(eq(readingSessions.id, sessionId)).run();
    const third = await beat("kid", { sessionId, bookId: kidsBook, seconds: 60 });
    expect(third.json().counted).toBe(60);
  });

  it("is a 404 for a book the reader can't see", async () => {
    const res = await beat("kid", { sessionId: randomUUID(), bookId: adultBook, seconds: 30 });
    expect(res.statusCode).toBe(404);
  });

  it("refuses someone else's session id", async () => {
    const sessionId = randomUUID();
    await beat("parent", { sessionId, bookId: kidsBook, seconds: 30 });
    const res = await beat("kid", { sessionId, bookId: kidsBook, seconds: 30 });
    expect(res.statusCode).toBe(409);
  });

  it("rejects oversized beats", async () => {
    const res = await beat("kid", { sessionId: randomUUID(), bookId: kidsBook, seconds: 3600 });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/reading/stats", () => {
  beforeEach(async () => {
    await beat("kid", { sessionId: randomUUID(), bookId: kidsBook, seconds: 120 });
    await beat("kid", { sessionId: randomUUID(), bookId: kidsBook, seconds: 60, kind: "listen" });
  });

  it("shows a kid their own minutes", async () => {
    const res = await stats("kid");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalSeconds).toBe(180);
    expect(body.days).toHaveLength(7);
    expect(body.days.at(-1)).toMatchObject({ readSeconds: 120, listenSeconds: 60 });
    expect(body.streakDays).toBe(1);
    expect(body.books).toEqual([{ id: kidsBook, title: "Dinosaur Picnic", coverPath: null, seconds: 180 }]);
  });

  it("lets a linked parent and an admin see a kid's stats", async () => {
    expect((await stats("parent", `?userId=${f.ids.kid}`)).json().totalSeconds).toBe(180);
    expect((await stats("admin", `?userId=${f.ids.kid}`)).json().totalSeconds).toBe(180);
  });

  it("hides a kid's stats from an unlinked adult and other kids' stats from a kid", async () => {
    expect((await stats("adult", `?userId=${f.ids.kid}`)).statusCode).toBe(404);
    expect((await stats("kid", `?userId=${f.ids.parent}`)).statusCode).toBe(403);
  });

  it("never lists a book above the kid's level, even if time was logged before a re-rating", async () => {
    f.db.update(books).set({ rating: "teen" }).where(eq(books.id, kidsBook)).run();
    const body = (await stats("parent", `?userId=${f.ids.kid}`)).json();
    expect(body.books).toEqual([]);
    expect(body.totalSeconds).toBe(180);
  });
});
