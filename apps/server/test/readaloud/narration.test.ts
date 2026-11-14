import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookFiles } from "../../src/db/schema.js";
import { resetCaptionMemory } from "../../src/narration/tts.js";
import { family, type Family } from "../helpers.js";
import { tempDir } from "../library/fixtures.js";
import { CHAPTER_ONE, fakeKokoro, makeStoryEpub } from "./fixtures.js";

let f: Family;
let dir: string;
let kokoro: ReturnType<typeof fakeKokoro>;
let kidsBook: string;
let adultBook: string;
let overlayBook: string;

async function setup(captions = true) {
  dir = await tempDir();
  kokoro = fakeKokoro({ captions });
  resetCaptionMemory();
  f = await family({ narration: { fetchImpl: kokoro.fetchImpl, cacheDir: join(dir, "cache") } }, { BOOKS_DIR: join(dir, "books"), CONFIG_DIR: join(dir, "config") });
  kidsBook = f.book("Pip and the Berry", "kids");
  adultBook = f.book("Grown-up Thriller", "adult");
  overlayBook = f.book("Read Along Pip", "kids");
  await makeStoryEpub(join(dir, "books", "pip.epub"), [CHAPTER_ONE]);
  await makeStoryEpub(join(dir, "books", "pip-ro.epub"), [CHAPTER_ONE], { mediaOverlay: true });
  f.db.insert(bookFiles).values({ bookId: kidsBook, relPath: "pip.epub", format: "epub", sizeBytes: 1 }).run();
  f.db.insert(bookFiles).values({ bookId: overlayBook, relPath: "pip-ro.epub", format: "epub", sizeBytes: 1 }).run();
}

const call = (who: "admin" | "parent" | "adult" | "kid", method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object, headers: Record<string, string> = {}) =>
  f.app.inject({ method, url, headers: { ...f.as(who), ...headers }, payload });

const turnOn = (extra: object = {}) =>
  call("admin", "PUT", "/api/admin/narration/settings", { enabled: true, baseUrl: "http://kokoro:8880/v1", defaultVoice: "af_heart", kidVoice: "af_bella", ...extra });

afterEach(async () => {
  await f.close();
  await rm(dir, { recursive: true, force: true });
});

describe("narration settings", () => {
  beforeEach(() => setup());

  it("is admin-only and never returns the API key", async () => {
    expect((await call("parent", "GET", "/api/admin/narration/settings")).statusCode).toBe(403);
    expect((await call("kid", "PUT", "/api/admin/narration/settings", { enabled: true })).statusCode).toBe(403);
    const res = await turnOn({ apiKey: "sekrit" });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain("sekrit");
    expect(res.json().settings.hasApiKey).toBe(true);
    // Saving again without apiKey keeps it.
    expect((await turnOn()).json().settings.hasApiKey).toBe(true);
  });

  it("needs an address before it can be switched on", async () => {
    expect((await call("admin", "PUT", "/api/admin/narration/settings", { enabled: true })).statusCode).toBe(400);
  });

  it("tests the server and lists its voices", async () => {
    await turnOn();
    const res = await call("admin", "POST", "/api/admin/narration/test", {});
    expect(res.json()).toMatchObject({ ok: true, wordTimings: true, voices: expect.arrayContaining(["af_heart", "bm_george"]) });
  });
});

describe("status and voices", () => {
  beforeEach(() => setup());

  it("reports off until an admin sets a server up", async () => {
    const res = await call("kid", "GET", `/api/narration/status?bookId=${kidsBook}`);
    expect(res.json()).toMatchObject({ server: false, mediaOverlay: false });
  });

  it("gives kids the kid voice and grown-ups the default", async () => {
    await turnOn();
    expect((await call("kid", "GET", `/api/narration/status?bookId=${kidsBook}`)).json()).toMatchObject({ server: true, voice: "af_bella", speed: 1 });
    expect((await call("adult", "GET", "/api/narration/status")).json().voice).toBe("af_heart");
  });

  it("spots EPUB3 media overlays", async () => {
    expect((await call("kid", "GET", `/api/narration/status?bookId=${overlayBook}`)).json().mediaOverlay).toBe(true);
  });

  it("404s a locked book's status (content lock)", async () => {
    expect((await call("kid", "GET", `/api/narration/status?bookId=${adultBook}`)).statusCode).toBe(404);
    expect((await call("adult", "GET", `/api/narration/status?bookId=${adultBook}`)).statusCode).toBe(200);
  });

  it("lets a person pick their own voice, and a parent pick a kid's; others get 404", async () => {
    await turnOn();
    expect((await call("kid", "PUT", "/api/narration/people/me", { voice: "bm_george", speed: 0.9 })).json()).toMatchObject({ effectiveVoice: "bm_george", speed: 0.9 });
    expect((await call("parent", "PUT", `/api/narration/people/${f.ids.kid}`, { voice: null, speed: 0.8 })).json()).toMatchObject({ effectiveVoice: "af_bella", speed: 0.8 });
    expect((await call("adult", "PUT", `/api/narration/people/${f.ids.kid}`, { voice: null, speed: 1 })).statusCode).toBe(404);
    expect((await call("kid", "PUT", `/api/narration/people/${f.ids.otherKid}`, { voice: null, speed: 1 })).statusCode).toBe(404);
  });
});

describe("speech", () => {
  it("speaks a sentence with word timings and caches it", async () => {
    await setup();
    await turnOn();
    const res = await call("kid", "POST", "/api/narration/speech", { bookId: kidsBook, text: "Pip the mouse lived under the old oak tree." });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ cached: false, voice: "af_bella" });
    expect(body.words).toHaveLength(9);
    expect(body.words[1]).toMatchObject({ word: "the", start: 0.4 });

    const again = (await call("kid", "POST", "/api/narration/speech", { bookId: kidsBook, text: "Pip the mouse lived under the old oak tree." })).json();
    expect(again).toMatchObject({ id: body.id, cached: true });
    expect(kokoro.speechCalls()).toHaveLength(1);

    const clip = await call("kid", "GET", body.url);
    expect(clip.statusCode).toBe(200);
    expect(clip.headers["content-type"]).toBe("audio/mpeg");
    expect(clip.body).toBe("MP3:af_bella:Pip the mouse lived under the old oak tree.");

    const part = await call("kid", "GET", body.url, undefined, { range: "bytes=0-3" });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe("MP3:");
  });

  it("falls back to plain speech when the server has no captions", async () => {
    await setup(false);
    await turnOn();
    const body = (await call("adult", "POST", "/api/narration/speech", { bookId: kidsBook, text: "Hello there." })).json();
    expect(body.words).toBeNull();
    expect(kokoro.speechCalls().map((c) => new URL(c.url).pathname)).toEqual(["/dev/captioned_speech", "/v1/audio/speech"]);
  });

  it("refuses locked books, and is 409 while switched off", async () => {
    await setup();
    expect((await call("kid", "POST", "/api/narration/speech", { bookId: kidsBook, text: "Hi." })).statusCode).toBe(409);
    await turnOn();
    expect((await call("kid", "POST", "/api/narration/speech", { bookId: adultBook, text: "Hi." })).statusCode).toBe(404);
    expect(kokoro.speechCalls()).toHaveLength(0);
  });

  it("only serves clip ids that look like hashes", async () => {
    await setup();
    expect((await call("kid", "GET", "/api/narration/clips/..%2F..%2Fsecret")).statusCode).toBe(400);
    expect((await call("kid", "GET", `/api/narration/clips/${"a".repeat(64)}`)).statusCode).toBe(404);
  });
});
