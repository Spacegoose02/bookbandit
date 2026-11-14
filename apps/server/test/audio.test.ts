import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { openDb, type Db } from "../src/db/client.js";
import { authors, bookAuthors, books, bookSeries, series } from "../src/db/schema.js";
import { audiobooks } from "../src/audio/schema.js";
import { scanAudiobooks } from "../src/audio/scanner.js";
import { readMp4Chapters } from "../src/audio/mp4chapters.js";
import { metadataFromPath, titleFromFileName } from "../src/audio/probe.js";
import { walkAudiobooks } from "../src/audio/walk.js";
import { storytellerSettings } from "../src/storyteller/schema.js";
import { kidShelf } from "../src/db/schema.js";
import { setBookAuthors } from "../src/library/store.js";
import { sortTitle } from "../src/metadata/text.js";
import { PNG, tempDir } from "./library/fixtures.js";
import { family, type Family } from "./helpers.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures/audio");

/** Lays out a small audiobook library: a two-file book, an M4B with chapters, a disc set. */
async function makeLibrary(root: string) {
  const put = async (rel: string, fixture: string) => {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await copyFile(join(FIX, fixture), join(root, rel));
  };
  await put("Jane Doe/The Quiet Fox/01 - Chapter One.mp3", "tone-a.mp3");
  await put("Jane Doe/The Quiet Fox/02 - Chapter Two.mp3", "tone-b.mp3");
  await writeFile(join(root, "Jane Doe/The Quiet Fox/cover.png"), PNG);
  await put("kids/Ola Night/Night Owls/Night Owls.m4b", "chapters.m4b");
  await put("Sam Lee/Two Discs/CD 1/01.mp3", "plain.mp3");
  await put("Sam Lee/Two Discs/CD 2/01.mp3", "plain.mp3");
}

describe("audiobook folders", () => {
  it("reads M4B chapter atoms", async () => {
    expect(await readMp4Chapters(join(FIX, "chapters.m4b"))).toEqual([
      { start: 0, title: "Opening" },
      { start: 2, title: "The Den" },
    ]);
  });

  it("guesses titles, authors and series from paths and file names", () => {
    expect(titleFromFileName("x/03 - The Den.mp3")).toBe("The Den");
    expect(titleFromFileName("x/Chapter 3.mp3")).toBe("Chapter 3");
    expect(metadataFromPath("Brandon Sanderson/Mistborn/Book 2 - The Well of Ascension")).toEqual({
      title: "The Well of Ascension",
      author: "Brandon Sanderson",
      series: "Mistborn",
      seriesPosition: 2,
    });
    expect(metadataFromPath("kids/Ola Night/Night Owls (2001)")).toMatchObject({ title: "Night Owls", author: "Ola Night", series: undefined });
    expect(metadataFromPath("Loose Story.m4b")).toMatchObject({ title: "Loose Story", author: undefined });
  });

  it("treats a folder as one book and disc folders as part of it", async () => {
    const root = await tempDir("bb-audio-");
    await makeLibrary(root);
    const units = await walkAudiobooks(root);
    expect(units.map((u) => [u.relPath, u.files.length, u.coverRelPath])).toEqual([
      ["Jane Doe/The Quiet Fox", 2, "Jane Doe/The Quiet Fox/cover.png"],
      ["kids/Ola Night/Night Owls", 1, null],
      ["Sam Lee/Two Discs", 2, null],
    ]);
    expect(units[2]!.files.map((f) => f.relPath)).toEqual(["Sam Lee/Two Discs/CD 1/01.mp3", "Sam Lee/Two Discs/CD 2/01.mp3"]);
  });
});

describe("audiobook scan", () => {
  let db: Db;
  let close: () => void;
  let root: string;
  let configDir: string;

  beforeEach(async () => {
    ({ db, close } = openDb(":memory:"));
    root = await tempDir("bb-audio-");
    configDir = await tempDir("bb-config-");
    await makeLibrary(root);
  });
  afterEach(() => close());

  const scan = () => scanAudiobooks({ db, audiobooksDir: root, configDir, online: false });
  const byTitle = (t: string) => db.select().from(books).where(eq(books.title, t)).get();

  it("adds new books to the inbox with tracks, chapters, narrator, cover and folder rating", async () => {
    const report = await scan();
    expect(report).toMatchObject({ foldersSeen: 3, added: 3, linked: 0, errors: [] });

    const fox = byTitle("The Quiet Fox")!;
    expect(fox.approved).toBe(false);
    expect(fox.coverPath).toBe(`covers/${fox.id}.png`);
    const a = db.select().from(audiobooks).where(eq(audiobooks.bookId, fox.id)).get()!;
    expect(a.narrator).toBe("Sam Reader");
    expect(a.tracks.map((t) => [t.title, t.startOffset > 0])).toEqual([
      ["Chapter One", false],
      ["Chapter Two", true],
    ]);
    expect(a.duration).toBeCloseTo(a.tracks[0]!.duration + a.tracks[1]!.duration, 5);
    // No chapter atoms: one chapter per file.
    expect(a.chapters.map((c) => c.title)).toEqual(["Chapter One", "Chapter Two"]);
    const names = db.select({ name: authors.name }).from(bookAuthors).innerJoin(authors, eq(authors.id, bookAuthors.authorId)).where(eq(bookAuthors.bookId, fox.id)).all();
    expect(names).toEqual([{ name: "Jane Doe" }]);

    const owls = byTitle("Night Owls")!;
    expect(owls.rating).toBe("kids"); // from the kids/ folder
    const o = db.select().from(audiobooks).where(eq(audiobooks.bookId, owls.id)).get()!;
    expect(o.chapters.map((c) => [c.title, c.start])).toEqual([
      ["Opening", 0],
      ["The Den", 2],
    ]);
    expect(o.chapters[1]!.end).toBeCloseTo(o.duration, 5);

    // Disc folders: "Two Discs" from the folder name, both discs in order.
    const discs = db.select().from(audiobooks).where(eq(audiobooks.relPath, "Sam Lee/Two Discs")).get()!;
    expect(discs.tracks).toHaveLength(2);
    expect(byTitle("Two Discs")?.id).toBe(discs.bookId);
  });

  it("links an audiobook to the ebook of the same work", async () => {
    const [ebook] = db.insert(books).values({ title: "The Quiet Fox", sortTitle: sortTitle("The Quiet Fox"), rating: "kids", approved: true }).returning().all();
    setBookAuthors(db, ebook!.id, ["Jane Doe"]);
    const report = await scan();
    expect(report).toMatchObject({ added: 2, linked: 1 });
    expect(db.select().from(audiobooks).where(eq(audiobooks.bookId, ebook!.id)).all()).toHaveLength(1);
    expect(db.select().from(books).where(eq(books.title, "The Quiet Fox")).all()).toHaveLength(1);
  });

  it("skips unchanged folders, follows moves and drops removed folders but keeps the book", async () => {
    await scan();
    expect(await scan()).toMatchObject({ unchanged: 3, added: 0 });
    const fox = byTitle("The Quiet Fox")!;

    await mkdir(join(root, "Moved"), { recursive: true });
    await rename(join(root, "Jane Doe/The Quiet Fox"), join(root, "Moved/The Quiet Fox"));
    expect(await scan()).toMatchObject({ moved: 1, added: 0, removed: 0 });
    expect(db.select().from(audiobooks).where(eq(audiobooks.bookId, fox.id)).get()!.relPath).toBe("Moved/The Quiet Fox");

    await rename(join(root, "Moved/The Quiet Fox"), join(root, ".hidden-away"));
    expect(await scan()).toMatchObject({ removed: 1 });
    expect(byTitle("The Quiet Fox")).toBeDefined();
  });

  it("puts a series from Author/Series/Title folders", async () => {
    await mkdir(join(root, "Ann Bee/Moon Cats/Book 2 - Star Paws"), { recursive: true });
    await copyFile(join(FIX, "tone-a.mp3"), join(root, "Ann Bee/Moon Cats/Book 2 - Star Paws/x.mp3"));
    await scan();
    // The album tag wins for the title; the folders still give the series.
    const book = db.select().from(audiobooks).where(eq(audiobooks.relPath, "Ann Bee/Moon Cats/Book 2 - Star Paws")).get()!;
    const s = db.select().from(bookSeries).innerJoin(series, eq(series.id, bookSeries.seriesId)).where(eq(bookSeries.bookId, book.bookId)).get();
    expect(s).toMatchObject({ series: { name: "Moon Cats" }, book_series: { position: 2 } });
  });
});

// ------------------------------------------------------------------ API

const ABS = "http://abs.local:13378";
const ADMIN_TOKEN = "abs-admin-token";
const DAD_KEY = "abs-key-for-dad-123";

interface AbsState {
  progress: Map<string, { currentTime: number; duration: number; isFinished: boolean; lastUpdate: number }>;
  patches: { itemId: string; body: { currentTime: number; isFinished: boolean } }[];
  bookmarks: { libraryItemId: string; title: string; time: number; createdAt: number }[];
}

function fakeAbs(state: AbsState): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const path = url.slice(ABS.length);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const auth = headers.Authorization;
    if (auth === `Bearer ${ADMIN_TOKEN}` && path === "/api/me") return json({ id: "abs-root", username: "root", mediaProgress: [], bookmarks: [] });
    if (auth !== `Bearer ${DAD_KEY}`) return new Response("no", { status: 401 });
    if (path === "/api/me") {
      return json({
        id: "abs-dad",
        username: "dad",
        mediaProgress: [...state.progress.entries()].map(([libraryItemId, p]) => ({ libraryItemId, episodeId: null, progress: p.currentTime / p.duration, ...p })),
        bookmarks: state.bookmarks,
      });
    }
    const m = path.match(/^\/api\/me\/progress\/([^/]+)$/);
    if (m) {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { currentTime: number; duration: number; isFinished: boolean };
        state.patches.push({ itemId: m[1]!, body });
        state.progress.set(m[1]!, { ...body, lastUpdate: Date.now() });
        return json({});
      }
      const p = state.progress.get(m[1]!);
      return p ? json({ libraryItemId: m[1], ...p }) : new Response("nf", { status: 404 });
    }
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
}

describe("listening API", () => {
  let f: Family;
  let root: string;
  let abs: AbsState;

  beforeEach(async () => {
    root = await tempDir("bb-audio-");
    await makeLibrary(root);
    abs = { progress: new Map(), patches: [], bookmarks: [] };
    f = await family({ integrations: { fetchImpl: fakeAbs(abs) } }, { AUDIOBOOKS_DIR: root, METADATA_ONLINE: "false", CONFIG_DIR: await tempDir("bb-config-") });
    await f.app.audio.service.startScan();
  });
  afterEach(() => f.close());

  const bookId = (title: string) => f.db.select().from(books).where(eq(books.title, title)).get()!.id;
  const approve = (id: string, rating: "kids" | "adult") => f.db.update(books).set({ approved: true, rating }).where(eq(books.id, id)).run();
  const get = (url: string, who: Parameters<Family["as"]>[0], headers: Record<string, string> = {}) =>
    f.app.inject({ method: "GET", url, headers: { ...f.as(who), ...headers } });

  it("plays a local audiobook with Range, behind the content lock and the inbox", async () => {
    const fox = bookId("The Quiet Fox");
    // Still in the inbox: nobody but an admin knows it exists.
    expect((await get(`/api/books/${fox}/audio`, "kid")).statusCode).toBe(404);
    approve(fox, "kids");

    const res = await get(`/api/books/${fox}/audio`, "kid");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ source: "local", title: "The Quiet Fox", author: "Jane Doe", narrator: "Sam Reader", progress: null, prefs: { speed: 1, skipSilence: false } });
    expect(body.tracks).toHaveLength(2);
    expect(body.chapters).toHaveLength(2);

    const track = await get(body.tracks[1].url, "kid", { range: "bytes=0-9" });
    expect(track.statusCode).toBe(206);
    expect(track.headers["content-type"]).toBe("audio/mpeg");
    expect(track.headers["content-range"]).toMatch(/^bytes 0-9\/\d+$/);
    expect(track.rawPayload.length).toBe(10);

    const cover = await get(body.coverUrl, "kid");
    expect(cover.statusCode).toBe(200);
    expect(cover.headers["content-type"]).toBe("image/png");

    const detail = await get(`/api/books/${fox}`, "kid");
    expect(detail.json().hasAudio).toBe(true);

    // An adult-rated audiobook doesn't exist for the kid: audio, tracks and cover all 404.
    const owls = bookId("Night Owls");
    approve(owls, "adult");
    for (const url of [`/api/books/${owls}/audio`, `/api/books/${owls}/audio/tracks/0`, `/api/books/${owls}/audio/cover`]) {
      expect((await get(url, "kid")).statusCode).toBe(404);
    }
    expect((await get(`/api/books/${owls}/audio/tracks/0`, "adult")).statusCode).toBe(200);
    expect((await get(`/api/books/${fox}/audio/tracks/9`, "kid")).statusCode).toBe(404);
  });

  it("keeps a storyteller kid's bedtime guard on local tracks", async () => {
    const fox = bookId("The Quiet Fox");
    approve(fox, "kids");
    f.db.insert(kidShelf).values({ kidId: f.ids.kid, bookId: fox, storyteller: true, addedBy: f.ids.parent }).run();
    f.db.insert(storytellerSettings).values({ kidId: f.ids.kid, enabled: true, updatedAt: Date.now() }).run();
    const res = await get(`/api/books/${fox}/audio/tracks/0`, "kid");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ goodnight: true });
  });

  it("syncs position (newest wins), the keep-listening shelf, speed per book and bookmarks with notes", async () => {
    const fox = bookId("The Quiet Fox");
    approve(fox, "kids");
    const put = (who: "kid" | "parent", currentTime: number, clientUpdatedAt: number) =>
      f.app.inject({ method: "PUT", url: `/api/books/${fox}/audio/progress`, headers: f.as(who), payload: { currentTime, duration: 500, clientUpdatedAt } });

    expect((await put("kid", 2, 2000)).json()).toMatchObject({ applied: true });
    expect((await put("kid", 1, 1000)).json()).toMatchObject({ applied: false, progress: { currentTime: 2 } });
    expect((await get(`/api/books/${fox}/audio`, "kid")).json().progress).toMatchObject({ currentTime: 2 });
    const shelf = await get("/api/audio/continue", "kid");
    expect(shelf.json().items.map((i: { id: string }) => i.id)).toEqual([fox]);

    const prefs = await f.app.inject({ method: "PUT", url: `/api/books/${fox}/audio/prefs`, headers: f.as("kid"), payload: { speed: 1.5 } });
    expect(prefs.json()).toEqual({ speed: 1.5, skipSilence: false });
    expect((await get(`/api/books/${fox}/audio`, "kid")).json().prefs).toEqual({ speed: 1.5, skipSilence: false });

    const made = await f.app.inject({ method: "POST", url: `/api/books/${fox}/audio/bookmarks`, headers: f.as("kid"), payload: { time: 3.5, note: "The fox finds the den" } });
    expect(made.statusCode).toBe(201);
    const bm = made.json();
    expect(bm).toMatchObject({ time: 3.5, note: "The fox finds the den", origin: "bookbandit" });
    // Someone else's bookmark is a 404, not a 403.
    expect((await f.app.inject({ method: "PATCH", url: `/api/audio/bookmarks/${bm.id}`, headers: f.as("parent"), payload: { note: "x" } })).statusCode).toBe(404);
    const edited = await f.app.inject({ method: "PATCH", url: `/api/audio/bookmarks/${bm.id}`, headers: f.as("kid"), payload: { note: "Den!" } });
    expect(edited.json().note).toBe("Den!");
    const list = await get(`/api/books/${fox}/audio/bookmarks`, "kid");
    expect(list.json().items.map((b: { note: string }) => b.note)).toEqual(["Den!"]);
    expect((await f.app.inject({ method: "DELETE", url: `/api/audio/bookmarks/${bm.id}`, headers: f.as("kid") })).statusCode).toBe(204);
    expect((await get(`/api/books/${fox}/audio/bookmarks`, "kid")).json().items).toEqual([]);
    const since = await get(`/api/books/${fox}/audio/bookmarks?since=0`, "kid");
    expect(since.json().items).toMatchObject([{ id: bm.id, deleted: true }]);

    // If the book gets locked later, the bookmarks go dark too.
    approve(fox, "adult");
    expect((await get(`/api/books/${fox}/audio/bookmarks`, "kid")).statusCode).toBe(404);
    expect((await get("/api/audio/continue", "kid")).json().items).toEqual([]);
  });

  it("scans from the admin API only", async () => {
    expect((await f.app.inject({ method: "POST", url: "/api/admin/audiobooks/scan", headers: f.as("parent") })).statusCode).toBe(403);
    const started = await f.app.inject({ method: "POST", url: "/api/admin/audiobooks/scan", headers: f.as("admin") });
    expect(started.statusCode).toBe(202);
    await f.app.audio.service.startScan();
    const status = await get("/api/admin/audiobooks/scan", "admin");
    expect(status.json()).toMatchObject({ running: false, lastReport: { unchanged: 3 } });
    const list = await get("/api/admin/audiobooks?q=fox", "admin");
    expect(list.json().items).toMatchObject([{ title: "The Quiet Fox", trackCount: 2, chapterCount: 2, approved: false }]);
    expect((await get("/api/admin/audiobooks", "kid")).statusCode).toBe(403);
  });

  it("rejecting an audiobook from the inbox moves its files aside so a rescan leaves it out", async () => {
    const owls = bookId("Night Owls");
    const res = await f.app.inject({ method: "POST", url: `/api/admin/inbox/${owls}/reject`, headers: f.as("admin"), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().movedTo).toEqual([".rejected/kids/Ola Night/Night Owls/Night Owls.m4b"]);
    await expect(stat(join(root, ".rejected/kids/Ola Night/Night Owls/Night Owls.m4b"))).resolves.toBeDefined();
    expect(await readdir(join(root, "kids/Ola Night"))).toEqual([]);
    const report = await f.app.audio.service.startScan();
    expect(report.added).toBe(0);
    expect(f.db.select().from(books).where(eq(books.title, "Night Owls")).get()).toBeUndefined();
  });

  it("merging books moves the audiobook and everyone's place", async () => {
    const fox = bookId("The Quiet Fox");
    approve(fox, "kids");
    const [ebook] = f.db.insert(books).values({ title: "Quiet Fox (ebook)", sortTitle: "quiet fox ebook", rating: "kids", approved: true }).returning().all();
    await f.app.inject({ method: "PUT", url: `/api/books/${fox}/audio/progress`, headers: f.as("kid"), payload: { currentTime: 3, duration: 500, clientUpdatedAt: 5000 } });
    const merged = await f.app.inject({ method: "POST", url: `/api/admin/books/${fox}/merge`, headers: f.as("admin"), payload: { intoId: ebook!.id } });
    expect(merged.statusCode).toBe(200);
    const res = await get(`/api/books/${ebook!.id}/audio`, "kid");
    expect(res.json()).toMatchObject({ source: "local", progress: { currentTime: 3 } });
  });

  describe("Audiobookshelf accounts", () => {
    let fox: string;

    beforeEach(async () => {
      fox = bookId("The Quiet Fox");
      approve(fox, "kids");
      f.db.update(books).set({ absItemId: "abs-fox" }).where(eq(books.id, fox)).run();
      const connect = await f.app.inject({
        method: "PUT",
        url: "/api/admin/integrations/audiobookshelf",
        headers: f.as("admin"),
        payload: { url: ABS, token: ADMIN_TOKEN },
      });
      expect(connect.statusCode).toBe(200);
    });

    const link = (token: string) =>
      f.app.inject({ method: "PUT", url: `/api/admin/audiobookshelf/accounts/${f.ids.parent}`, headers: f.as("admin"), payload: { token } });

    it("are admin-only, checked against ABS, and never echo the key", async () => {
      expect((await f.app.inject({ method: "PUT", url: `/api/admin/audiobookshelf/accounts/${f.ids.parent}`, headers: f.as("parent"), payload: { token: DAD_KEY } })).statusCode).toBe(403);
      expect((await link("wrong-key-000")).statusCode).toBe(422);
      const ok = await link(DAD_KEY);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ absUsername: "dad", writeBack: true });
      const list = await get("/api/admin/audiobookshelf/accounts", "admin");
      expect(list.body).not.toContain(DAD_KEY);
      expect(list.json().items.find((i: { userId: string }) => i.userId === f.ids.parent).account).toMatchObject({ absUsername: "dad" });
    });

    it("imports positions, finished flags and bookmarks; newer local positions win", async () => {
      await link(DAD_KEY);
      abs.progress.set("abs-fox", { currentTime: 4, duration: 5, isFinished: false, lastUpdate: 10_000 });
      abs.progress.set("abs-unlinked", { currentTime: 1, duration: 9, isFinished: true, lastUpdate: 10_000 });
      abs.bookmarks.push({ libraryItemId: "abs-fox", title: "Great line", time: 2.5, createdAt: 9000 });

      const dry = await f.app.inject({ method: "POST", url: "/api/admin/audiobookshelf/import", headers: f.as("admin"), payload: { dryRun: true } });
      expect(dry.json().reports[0]).toMatchObject({ imported: 1, unlinked: 1, bookmarksImported: 1 });
      expect((await get(`/api/books/${fox}/audio/progress`, "parent")).json().progress).toBeNull();

      const real = await f.app.inject({ method: "POST", url: "/api/admin/audiobookshelf/import", headers: f.as("admin"), payload: {} });
      expect(real.json().reports[0]).toMatchObject({ absUsername: "dad", imported: 1, keptNewer: 0, bookmarksImported: 1 });
      expect((await get(`/api/books/${fox}/audio/progress`, "parent")).json().progress).toMatchObject({ currentTime: 4, deviceName: "Audiobookshelf" });
      expect((await get(`/api/books/${fox}/audio/bookmarks`, "parent")).json().items).toMatchObject([{ time: 2.5, note: "Great line", origin: "audiobookshelf" }]);

      // Again: nothing new, the bookmark isn't doubled.
      const again = await f.app.inject({ method: "POST", url: "/api/admin/audiobookshelf/import", headers: f.as("admin"), payload: {} });
      expect(again.json().reports[0]).toMatchObject({ imported: 0, keptNewer: 1, bookmarksImported: 0, bookmarksSkipped: 1 });
    });

    it("writes positions back to ABS, and takes ABS's when it is newer", async () => {
      await link(DAD_KEY);
      const now = Date.now();
      await f.app.inject({ method: "PUT", url: `/api/books/${fox}/audio/progress`, headers: f.as("parent"), payload: { currentTime: 3, duration: 500, clientUpdatedAt: now } });
      await f.app.audio.sync.whenIdle();
      expect(abs.patches).toEqual([{ itemId: "abs-fox", body: expect.objectContaining({ currentTime: 3, isFinished: false }) }]);

      // Someone listened further in the ABS app later: opening the player picks that up.
      abs.progress.set("abs-fox", { currentTime: 4.5, duration: 5, isFinished: false, lastUpdate: now + 60_000 });
      const res = await get(`/api/books/${fox}/audio`, "parent");
      expect(res.json().progress).toMatchObject({ currentTime: 4.5, deviceName: "Audiobookshelf" });

      // An older save from a tablet that was offline doesn't overwrite ABS's newer place.
      const stale = await f.app.inject({ method: "PUT", url: `/api/books/${fox}/audio/progress`, headers: f.as("parent"), payload: { currentTime: 1, duration: 500, clientUpdatedAt: now + 1000 } });
      expect(stale.json().applied).toBe(false);
      await f.app.audio.sync.whenIdle();
      expect(abs.patches).toHaveLength(1);

      // Write-back off: nothing goes to ABS.
      await f.app.inject({ method: "PUT", url: `/api/admin/audiobookshelf/accounts/${f.ids.parent}`, headers: f.as("admin"), payload: { writeBack: false } });
      await f.app.inject({ method: "PUT", url: `/api/books/${fox}/audio/progress`, headers: f.as("parent"), payload: { currentTime: 4.9, duration: 500, clientUpdatedAt: now + 120_000 } });
      await f.app.audio.sync.whenIdle();
      expect(abs.patches).toHaveLength(1);
    });

    it("people without an ABS account are never pushed", async () => {
      await f.app.inject({ method: "PUT", url: `/api/books/${fox}/audio/progress`, headers: f.as("kid"), payload: { currentTime: 3, duration: 500, clientUpdatedAt: Date.now() } });
      await f.app.audio.sync.whenIdle();
      expect(abs.patches).toEqual([]);
    });
  });
});
