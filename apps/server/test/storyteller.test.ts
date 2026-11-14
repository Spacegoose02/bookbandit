import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bookFiles, kidShelf } from "../src/db/schema.js";
import { family, type Family } from "./helpers.js";

const ABS = "http://abs.local:13378";
const TOKEN = "abs-token";

const item = (id: string) => ({
  id,
  libraryId: "lib1",
  mediaType: "book",
  media: {
    metadata: { title: id, authorName: "Someone" },
    duration: 600,
    chapters: [],
    audioFiles: [{ index: 1, ino: "ino-a", duration: 600, mimeType: "audio/mpeg", metadata: { filename: "01.mp3" } }],
  },
});

const fakeFetch = (async (input: string | URL | Request) => {
  const path = String(input).slice(ABS.length);
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  if (path === "/api/me") return json({ username: "root" });
  const m = path.match(/^\/api\/items\/([^/?]+)\?expanded=1$/);
  if (m) return json(item(m[1]!));
  if (/^\/api\/items\/[^/]+\/file\//.test(path)) return new Response("AUDIO", { headers: { "content-type": "audio/mpeg" } });
  return new Response("nf", { status: 404 });
}) as typeof fetch;

let f: Family;
let now: number;
let gruffalo: string;
let owl: string;
let picture: string;
let notOnShelf: string;
let teen: string;

beforeEach(async () => {
  f = await family({ integrations: { fetchImpl: fakeFetch } });
  now = Date.parse("2026-11-14T19:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await f.app.inject({
    method: "PUT",
    url: "/api/admin/integrations/audiobookshelf",
    headers: f.as("admin"),
    payload: { url: ABS, token: TOKEN },
  });
  gruffalo = f.book("The Gruffalo", "kids", { absItemId: "abs-gruffalo" });
  owl = f.book("Owl Babies", "kids", { absItemId: "abs-owl" });
  picture = f.book("Goodnight Moon", "kids");
  notOnShelf = f.book("Room on the Broom", "kids", { absItemId: "abs-broom" });
  teen = f.book("Teen Thing", "teen", { absItemId: "abs-teen" });
  f.db.insert(bookFiles).values({ bookId: picture, relPath: "kids/moon.epub", format: "epub", sizeBytes: 100 }).run();
  for (const b of [gruffalo, owl, picture, teen]) {
    f.db.insert(kidShelf).values({ kidId: f.ids.kid, bookId: b, storyteller: true, addedBy: f.ids.parent }).run();
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.close();
});

const call = (who: "admin" | "parent" | "adult" | "kid", method: "GET" | "PUT" | "POST", url: string, payload?: object) =>
  f.app.inject({ method, url, headers: f.as(who), payload });

const limits = (payload: Partial<Record<string, unknown>> = {}) =>
  call("parent", "PUT", `/api/storyteller/kids/${f.ids.kid}/settings`, {
    enabled: true,
    storiesPerNight: 2,
    minutesPerNight: null,
    sleepTimerMinutes: 15,
    readAloud: true,
    timeZone: "America/Chicago",
    nightStartsHour: 12,
    ...payload,
  });

async function start(bookId: string, mode: "audio" | "read_aloud" = "audio") {
  return call("kid", "POST", "/api/storyteller/stories", { bookId, mode });
}

/** Play for `seconds`, with a heartbeat every 30 s like the web player. */
async function listen(sessionId: string, seconds: number) {
  let last;
  for (let t = 0; t < seconds; t += 30) {
    now += Math.min(30, seconds - t) * 1000;
    last = (await call("kid", "POST", `/api/storyteller/sessions/${sessionId}/beat`, { playing: true })).json();
  }
  return last;
}

describe("storyteller screen", () => {
  it("lists the kid's storyteller shelf through the content lock", async () => {
    const res = await call("kid", "GET", "/api/storyteller/kids/me");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const titles = body.stories.map((s: { title: string }) => s.title);
    expect(titles).toEqual(["Goodnight Moon", "Owl Babies", "The Gruffalo"]); // teen book is locked
    expect(body.stories[0]).toMatchObject({ hasAudio: false, canReadAloud: true });
    expect(body.stories[2]).toMatchObject({ hasAudio: true, canReadAloud: false });
    expect(body.canEdit).toBe(false);
    expect(body.tonight.goodnight).toBe(false);
  });

  it("is visible to a linked parent and admin, 404 for anyone else", async () => {
    expect((await call("parent", "GET", `/api/storyteller/kids/${f.ids.kid}`)).json().canEdit).toBe(true);
    expect((await call("admin", "GET", `/api/storyteller/kids/${f.ids.kid}`)).statusCode).toBe(200);
    expect((await call("adult", "GET", `/api/storyteller/kids/${f.ids.kid}`)).statusCode).toBe(404);
    expect((await call("kid", "GET", `/api/storyteller/kids/${f.ids.otherKid}`)).statusCode).toBe(404);
  });
});

describe("settings", () => {
  it("only a parent or admin can set the limits; the kid gets 403", async () => {
    expect((await limits()).statusCode).toBe(200);
    const kidTry = await call("kid", "PUT", "/api/storyteller/kids/me/settings", {
      enabled: false,
      storiesPerNight: null,
      minutesPerNight: null,
      sleepTimerMinutes: null,
      readAloud: true,
      timeZone: "UTC",
      nightStartsHour: 12,
    });
    expect(kidTry.statusCode).toBe(403);
    expect((await call("adult", "PUT", `/api/storyteller/kids/${f.ids.kid}/settings`, {})).statusCode).toBe(404);
    expect((await limits({ timeZone: "Mars/Olympus" })).statusCode).toBe(400);
    expect((await call("kid", "GET", "/api/storyteller/kids/me")).json().settings).toMatchObject({ storiesPerNight: 2, enabled: true });
  });
});

describe("nightly limits", () => {
  it("a story limit lets the current story finish and stops the next one", async () => {
    await limits({ storiesPerNight: 2 });
    const a = (await start(gruffalo)).json();
    await listen(a.session.id, 120);
    await call("kid", "POST", `/api/storyteller/sessions/${a.session.id}/end`, { playing: true, completed: true });

    const b = await start(owl);
    expect(b.statusCode).toBe(201);
    await listen(b.json().session.id, 60);
    // Tablet goes to sleep mid-story; resuming the same story is still fine.
    expect((await start(owl)).statusCode).toBe(201);

    const c = await start(picture, "read_aloud");
    expect(c.statusCode).toBe(409);
    expect(c.json()).toMatchObject({ goodnight: true, tonight: { storiesUsed: 2, storiesLeft: 0, goodnight: true } });
    // A story already finished tonight can't be replayed past the limit either.
    expect((await start(gruffalo)).statusCode).toBe(409);
  });

  it("taps that last under 20 seconds don't use up a story", async () => {
    await limits({ storiesPerNight: 1 });
    const a = (await start(gruffalo)).json();
    await listen(a.session.id, 10);
    const b = await start(owl);
    expect(b.statusCode).toBe(201);
    expect(b.json().tonight.storiesUsed).toBe(0);
  });

  it("a minute limit stops the story mid-way on the server's clock", async () => {
    await limits({ storiesPerNight: null, minutesPerNight: 5 });
    const a = (await start(gruffalo)).json();
    const last = await listen(a.session.id, 300);
    expect(last).toMatchObject({ stop: true, tonight: { secondsLeft: 0, goodnight: true } });
    expect((await start(owl)).statusCode).toBe(409);
  });

  it("a long gap between heartbeats is not billed in full, and paused time is free", async () => {
    await limits({ storiesPerNight: null, minutesPerNight: 30 });
    const a = (await start(gruffalo)).json();
    now += 10 * 60_000;
    const beat = (await call("kid", "POST", `/api/storyteller/sessions/${a.session.id}/beat`, { playing: true })).json();
    expect(beat.tonight.secondsUsed).toBe(45);
    now += 60_000;
    const paused = (await call("kid", "POST", `/api/storyteller/sessions/${a.session.id}/beat`, { playing: false })).json();
    expect(paused.tonight.secondsUsed).toBe(45);
  });

  it("resets the next night (noon in the family's time zone)", async () => {
    await limits({ storiesPerNight: 1 });
    const a = (await start(gruffalo)).json();
    await listen(a.session.id, 60);
    expect((await start(owl)).statusCode).toBe(409);
    // 1 a.m. Chicago is still the same night...
    now = Date.parse("2026-11-15T07:00:00Z");
    expect((await start(owl)).statusCode).toBe(409);
    // ...noon Chicago the next day is a new one.
    now = Date.parse("2026-11-15T18:01:00Z");
    expect((await start(owl)).statusCode).toBe(201);
  });

  it("only kids start stories, only from their storyteller shelf, only visible books", async () => {
    expect((await call("parent", "POST", "/api/storyteller/stories", { bookId: gruffalo, mode: "audio" })).statusCode).toBe(403);
    expect((await start(notOnShelf)).statusCode).toBe(404);
    expect((await start(teen)).statusCode).toBe(404);
    expect((await start(picture, "audio")).statusCode).toBe(422);
    expect((await start(gruffalo, "read_aloud")).statusCode).toBe(422);
  });

  it("a kid can't beat or end someone else's session", async () => {
    const a = (await start(gruffalo)).json();
    expect((await call("parent", "POST", `/api/storyteller/sessions/${a.session.id}/beat`, { playing: true })).statusCode).toBe(403);
  });
});

describe("audio guard", () => {
  const track = (bookId: string, who: "kid" | "parent" = "kid") => call(who, "GET", `/api/books/${bookId}/audio/tracks/0`);

  it("leaves kids without storyteller mode alone", async () => {
    expect((await track(gruffalo)).statusCode).toBe(200);
  });

  it("with storyteller on, a kid streams only inside a live session with minutes left", async () => {
    await limits({ storiesPerNight: null, minutesPerNight: 5 });
    expect((await track(gruffalo)).statusCode).toBe(403);
    const a = (await start(gruffalo)).json();
    expect((await track(gruffalo)).statusCode).toBe(200);
    expect((await track(owl)).statusCode).toBe(403); // another book needs its own session
    await listen(a.session.id, 300);
    const after = await track(gruffalo);
    expect(after.statusCode).toBe(403);
    expect(after.json()).toMatchObject({ goodnight: true });
    // Grown-ups are never affected.
    expect((await track(gruffalo, "parent")).statusCode).toBe(200);
  });

  it("a session left open without heartbeats stops unlocking audio", async () => {
    await limits({ storiesPerNight: null, minutesPerNight: null });
    await start(gruffalo);
    expect((await track(gruffalo)).statusCode).toBe(200);
    now += 6 * 60_000;
    expect((await track(gruffalo)).statusCode).toBe(403);
  });
});

describe("history", () => {
  it("shows a parent what was played", async () => {
    const a = (await start(gruffalo)).json();
    await listen(a.session.id, 90);
    const h = (await call("parent", "GET", `/api/storyteller/kids/${f.ids.kid}/history`)).json();
    expect(h.items[0]).toMatchObject({ title: "The Gruffalo", mode: "audio", listenedSeconds: 90 });
    expect((await call("adult", "GET", `/api/storyteller/kids/${f.ids.kid}/history`)).statusCode).toBe(404);
  });
});
