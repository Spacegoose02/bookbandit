import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { bookFiles, books, jobs, settings } from "../src/db/schema.js";
import { family, type Family } from "./helpers.js";
import { makeEpub, tempDir } from "./library/fixtures.js";

/**
 * A fake outside world: Shelfmark, sabnzbd, a Newznab indexer and a plain file host.
 * Every request is recorded so tests can check what was sent (and that keys went in headers).
 */
interface World {
  calls: { url: string; headers: Record<string, string>; body?: string }[];
  epub: Buffer;
  shelfmarkState: string;
  shelfmarkReleases: unknown[];
  shelfmarkBooks: unknown[];
  sabQueued: boolean;
  sabStatus: string;
  sabStorage: string;
}

function makeFetch(w: World) {
  return async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    w.calls.push({ url: input, headers, body: typeof init.body === "string" ? init.body : undefined });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

    if (url.host === "shelfmark.local") {
      if (headers["x-api-key"] !== "sm-key") return json({ error: "Unauthorized" }, 401);
      if (url.pathname === "/api/metadata/search") return json({ books: w.shelfmarkBooks });
      if (url.pathname === "/api/releases") return json({ releases: w.shelfmarkReleases });
      if (url.pathname === "/api/releases/download") return json({ status: "queued", priority: 0 });
      if (url.pathname === "/api/status") return json({ [w.shelfmarkState]: { md5abc: { id: "md5abc", progress: 40, status_message: "boom" } } });
      if (url.pathname === "/api/localdownload")
        return new Response(w.epub, {
          headers: { "content-type": "application/epub+zip", "content-disposition": 'attachment; filename="Charlotte\'s Web - E. B. White.epub"' },
        });
    }
    if (url.host === "sab.local") {
      if (url.searchParams.get("apikey") !== "sab-key") return json({ status: false, error: "API Key Incorrect" });
      const mode = url.searchParams.get("mode");
      if (mode === "version") return json({ version: "4.3.2" });
      if (mode === "addurl") {
        w.sabQueued = true;
        return json({ status: true, nzo_ids: ["SABnzbd_nzo_1"] });
      }
      if (mode === "queue") return json({ queue: { slots: w.sabStatus === "Downloading" ? [{ nzo_id: "SABnzbd_nzo_1", status: "Downloading", percentage: "55" }] : [] } });
      if (mode === "history")
        return json({ history: { slots: w.sabStatus === "Downloading" ? [] : [{ nzo_id: "SABnzbd_nzo_1", status: w.sabStatus, storage: w.sabStorage, fail_message: "CRC error" }] } });
    }
    if (url.host === "indexer.local") {
      return new Response(
        `<?xml version="1.0"?><rss><channel>
          <item><title>Some Other Book EPUB</title><enclosure url="https://indexer.local/get/1.nzb" length="1000"/></item>
          <item><title>E B White - Charlottes Web (2001) EPUB</title><enclosure url="https://indexer.local/get/2.nzb?apikey=nz-key" length="2000"/></item>
        </channel></rss>`,
        { headers: { "content-type": "application/rss+xml" } },
      );
    }
    if (url.host === "files.local") {
      if (url.pathname === "/page") return new Response("<html></html>", { headers: { "content-type": "text/html" } });
      if (url.pathname === "/missing.epub") return new Response("nope", { status: 404 });
      return new Response(w.epub, { headers: { "content-type": "application/epub+zip" } });
    }
    return new Response("not found", { status: 404 });
  };
}

let f: Family;
let dir: string;
let w: World;

beforeEach(async () => {
  dir = await tempDir("bb-dl-");
  const epubPath = join(dir, "..", `fixture-${Date.now()}-${Math.random()}.epub`);
  await makeEpub(epubPath, { title: "Charlotte's Web", authors: ["E. B. White"], subjects: ["Picture books"] });
  w = {
    calls: [],
    epub: readFileSync(epubPath),
    shelfmarkState: "downloading",
    shelfmarkBooks: [{ provider: "hardcover", provider_id: "123", title: "Charlotte's Web", authors: ["E. B. White"] }],
    shelfmarkReleases: [
      { source: "direct_download", source_id: "md5pdf", title: "Charlotte's Web", format: "pdf" },
      { source: "direct_download", source_id: "md5abc", title: "Charlotte's Web", format: "epub", size: "1 MB" },
    ],
    sabQueued: false,
    sabStatus: "Downloading",
    sabStorage: "/downloads/complete/Charlottes Web",
  };
  rmSync(epubPath);
  const fetchImpl = makeFetch(w);
  f = await family(
    { requests: { fetchImpl, pollMs: { shelfmark: 1000, sabnzbd: 1000 } }, integrations: { fetchImpl } },
    { BOOKS_DIR: dir, METADATA_ONLINE: "false", LIBRARY_SCAN_ON_START: "false" },
  );
});
afterEach(async () => {
  await f.close();
  rmSync(dir, { recursive: true, force: true });
});

type Who = Parameters<Family["as"]>[0];
const put = (who: Who, payload: unknown) =>
  f.app.inject({ method: "PUT", url: "/api/admin/downloads/settings", headers: f.as(who), payload });

const useShelfmark = () => put("admin", { shelfmark: { url: "https://shelfmark.local/", apiKey: "sm-key" } });

/** Run due jobs, then pretend the polling delay passed, until nothing is waiting. */
async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await f.app.jobs.drain();
    const waiting = f.db.select().from(jobs).where(eq(jobs.status, "queued")).all();
    if (!waiting.length) return;
    f.db.update(jobs).set({ runAfter: 0 }).where(eq(jobs.status, "queued")).run();
  }
}

describe("downloader settings", () => {
  it("are admin-only and never send keys back", async () => {
    for (const who of ["parent", "adult", "kid"] as const) {
      expect((await put(who, { autoDownload: false })).statusCode).toBe(403);
      expect((await f.app.inject({ url: "/api/admin/downloads/settings", headers: f.as(who) })).statusCode).toBe(403);
      expect((await f.app.inject({ method: "POST", url: "/api/admin/downloads", headers: f.as(who), payload: { url: "https://files.local/a.epub" } })).statusCode).toBe(403);
    }
    const res = await useShelfmark();
    expect(res.statusCode).toBe(200);
    expect(res.json().shelfmark).toEqual({ enabled: true, url: "https://shelfmark.local", hasApiKey: true });
    expect(res.json().available).toEqual(["shelfmark"]);
    expect(JSON.stringify(res.json())).not.toContain("sm-key");
    // Stored sealed, too.
    expect(JSON.stringify(f.db.select().from(settings).all())).not.toContain("sm-key");
    // Keeps the key when it's left out.
    const again = await put("admin", { shelfmark: { url: "https://shelfmark.local", enabled: false } });
    expect(again.json().shelfmark).toMatchObject({ enabled: false, hasApiKey: true });
    expect((await put("admin", { sabnzbd: { url: "https://sab.local" } })).statusCode).toBe(400);
  });

  it("tests connections", async () => {
    await useShelfmark();
    await put("admin", { sabnzbd: { url: "https://sab.local", apiKey: "wrong" } });
    const sm = await f.app.inject({ method: "POST", url: "/api/admin/downloads/test", headers: f.as("admin"), payload: { client: "shelfmark" } });
    expect(sm.json()).toMatchObject({ ok: true });
    const sab = await f.app.inject({ method: "POST", url: "/api/admin/downloads/test", headers: f.as("admin"), payload: { client: "sabnzbd" } });
    expect(sab.json()).toMatchObject({ ok: false, message: "sabnzbd: API Key Incorrect" });
  });
});

describe("kid → parent approval → Shelfmark → inbox", () => {
  it("downloads the approved book into the inbox and links the request, behind the content lock", async () => {
    await useShelfmark();
    const created = await f.app.inject({ method: "POST", url: "/api/requests", headers: f.as("kid"), payload: { title: "Charlotte's Web", author: "E. B. White" } });
    const id = created.json().request.id;
    expect(created.json().request.status).toBe("pending");
    // Nothing is downloaded before a parent says yes.
    await settle();
    expect(w.calls.filter((c) => c.url.includes("shelfmark"))).toEqual([]);

    const approved = await f.app.inject({ method: "POST", url: `/api/requests/${id}/approve`, headers: f.as("parent") });
    expect(approved.json().status).toBe("downloading");

    await f.app.jobs.drain();
    // Searched, picked the EPUB release over the PDF, queued it, and is now waiting on Shelfmark.
    const queued = w.calls.find((c) => c.url.endsWith("/api/releases/download"))!;
    expect(JSON.parse(queued.body!)).toMatchObject({ source_id: "md5abc", format: "epub" });
    expect(w.calls.every((c) => !c.url.includes("sm-key"))).toBe(true);
    const job = f.db.select().from(jobs).where(eq(jobs.type, "downloads.fetch")).get()!;
    expect(job).toMatchObject({ status: "queued", attempts: 0 });

    // Shelfmark is still working: progress shows up on the request.
    f.db.update(jobs).set({ runAfter: 0 }).run();
    await f.app.jobs.drain();
    const mid = await f.app.inject({ url: `/api/requests/${id}`, headers: f.as("kid") });
    expect(mid.json()).toMatchObject({ status: "downloading", download: { status: "queued", progress: 0.4, jobId: null } });

    w.shelfmarkState = "complete";
    await settle();

    const files = f.db.select().from(bookFiles).all();
    expect(files.map((x) => x.relPath)).toEqual([`_incoming/requests/${id}/Charlotte's Web - E. B. White.epub`]);
    const book = f.db.select().from(books).where(eq(books.id, files[0]!.bookId)).get()!;
    expect(book).toMatchObject({ approved: false, title: "Charlotte's Web" });
    expect(readdirSync(join(dir, "_incoming", ".partial"))).toEqual([]);

    // Done, but the kid can't see the book until an admin approves it in the inbox.
    const kidView = (await f.app.inject({ url: `/api/requests/${id}`, headers: f.as("kid") })).json();
    expect(kidView).toMatchObject({ status: "done", book: null, waitingForReview: true });
    const adminView = (await f.app.inject({ url: `/api/requests/${id}`, headers: f.as("admin") })).json();
    expect(adminView.book.id).toBe(book.id);
    const inbox = await f.app.inject({ url: "/api/admin/inbox", headers: f.as("admin") });
    expect(inbox.json().items.map((b: { id: string }) => b.id)).toContain(book.id);

    // Approved as adult: still locked for the kid.
    await f.app.inject({ method: "POST", url: `/api/admin/inbox/${book.id}/approve`, headers: f.as("admin"), payload: { rating: "adult" } });
    expect((await f.app.inject({ url: `/api/requests/${id}`, headers: f.as("kid") })).json().book).toBeNull();
    // Rated for kids: now the request links to it.
    await f.app.inject({ method: "PUT", url: `/api/admin/books/${book.id}/rating`, headers: f.as("admin"), payload: { rating: "kids" } });
    expect((await f.app.inject({ url: `/api/requests/${id}`, headers: f.as("kid") })).json().book).toMatchObject({ id: book.id });

    const logs = (await f.app.inject({ url: `/api/admin/jobs/${job.id}`, headers: f.as("admin") })).json().logs.map((l: { message: string }) => l.message);
    expect(logs.join("\n")).toMatch(/Shelfmark: queueing epub/);
    expect(logs.join("\n")).toMatch(/In the inbox: 1 book/);
  });

  it("marks the request failed when Shelfmark reports an error", async () => {
    await useShelfmark();
    w.shelfmarkState = "error";
    const id = (await f.app.inject({ method: "POST", url: "/api/requests", headers: f.as("adult"), payload: { title: "Charlotte's Web" } })).json().request.id;
    await f.app.inject({ method: "POST", url: `/api/requests/${id}/approve`, headers: f.as("admin") });
    await settle();
    const r = (await f.app.inject({ url: `/api/requests/${id}`, headers: f.as("adult") })).json();
    expect(r).toMatchObject({ status: "failed", note: "Shelfmark: boom" });
    // An admin can retry it from the request.
    const retry = await f.app.inject({ method: "POST", url: `/api/admin/requests/${id}/download`, headers: f.as("admin"), payload: {} });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().status).toBe("downloading");
  });

  it("fails cleanly when Shelfmark has no readable release", async () => {
    await useShelfmark();
    w.shelfmarkReleases = [{ source: "x", source_id: "1", title: "Charlotte's Web", format: "djvu" }];
    const id = (await f.app.inject({ method: "POST", url: "/api/requests", headers: f.as("admin"), payload: { title: "Charlotte's Web" } })).json().request.id;
    await settle();
    expect((await f.app.inject({ url: `/api/requests/${id}`, headers: f.as("admin") })).json()).toMatchObject({ status: "failed" });
  });

  it("doesn't start a download when auto-download is off", async () => {
    await useShelfmark();
    await put("admin", { autoDownload: false });
    const id = (await f.app.inject({ method: "POST", url: "/api/requests", headers: f.as("admin"), payload: { title: "Charlotte's Web" } })).json().request.id;
    await settle();
    expect((await f.app.inject({ url: `/api/requests/${id}`, headers: f.as("admin") })).json()).toMatchObject({ status: "approved", canDownload: true });
  });
});

describe("sabnzbd with a Newznab indexer", () => {
  it("finds the NZB, waits for sabnzbd and copies the book from its completed folder", async () => {
    const sabDir = join(dir, "..", `sab-${Date.now()}`);
    mkdirSync(join(sabDir, "Charlottes Web", "sub"), { recursive: true });
    writeFileSync(join(sabDir, "Charlottes Web", "sub", "charlotte.epub"), w.epub);
    writeFileSync(join(sabDir, "Charlottes Web", "readme.nfo"), "x");
    try {
      await put("admin", {
        order: ["sabnzbd", "shelfmark"],
        sabnzbd: { url: "https://sab.local", apiKey: "sab-key", pathMap: { from: "/downloads/complete", to: sabDir } },
        newznab: { url: "https://indexer.local", apiKey: "nz-key" },
      });
      const id = (await f.app.inject({ method: "POST", url: "/api/requests", headers: f.as("admin"), payload: { title: "Charlotte's Web", author: "E. B. White" } })).json().request.id;
      await f.app.jobs.drain();
      const add = w.calls.find((c) => c.url.includes("mode=addurl"))!;
      expect(new URL(add.url).searchParams.get("name")).toBe("https://indexer.local/get/2.nzb?apikey=nz-key");
      expect(new URL(add.url).searchParams.get("cat")).toBe("books");

      w.sabStatus = "Completed";
      await settle();
      const r = (await f.app.inject({ url: `/api/requests/${id}`, headers: f.as("admin") })).json();
      expect(r.status).toBe("done");
      expect(f.db.select().from(bookFiles).all().map((x) => x.relPath)).toEqual([`_incoming/requests/${id}/charlotte.epub`]);
      // The job log never shows the indexer key.
      const logs = JSON.stringify((await f.app.inject({ url: `/api/admin/jobs/${r.download?.jobId}`, headers: f.as("admin") })).json().logs);
      expect(logs).not.toContain("nz-key");
    } finally {
      rmSync(sabDir, { recursive: true, force: true });
    }
  });

  it("falls back to the next downloader when the first finds nothing", async () => {
    await put("admin", {
      order: ["shelfmark", "sabnzbd"],
      shelfmark: { url: "https://shelfmark.local", apiKey: "sm-key" },
      sabnzbd: { url: "https://sab.local", apiKey: "sab-key" },
      newznab: { url: "https://indexer.local", apiKey: "nz-key" },
    });
    w.shelfmarkBooks = [];
    await f.app.inject({ method: "POST", url: "/api/requests", headers: f.as("admin"), payload: { title: "Charlotte's Web", author: "E. B. White" } });
    await f.app.jobs.drain();
    expect(w.sabQueued).toBe(true);
  });
});

describe("direct downloads", () => {
  const start = (url: string, who: Who = "admin") =>
    f.app.inject({ method: "POST", url: "/api/admin/downloads", headers: f.as(who), payload: { url, title: "Charlotte" } });

  it("downloads a file into the inbox", async () => {
    const res = await start("https://files.local/books/charlotte.epub?token=secret");
    expect(res.statusCode).toBe(202);
    expect(res.json().label).not.toContain("secret");
    await settle();
    const job = (await f.app.inject({ url: `/api/admin/jobs/${res.json().id}`, headers: f.as("admin") })).json();
    expect(job).toMatchObject({ status: "done", result: { via: "direct" } });
    expect(JSON.stringify(job.logs)).not.toContain("secret");
    const rel = job.result.files[0] as string;
    expect(rel).toMatch(/^_incoming\/direct\/[^/]+\/charlotte\.epub$/);
    expect(existsSync(join(dir, rel))).toBe(true);
    expect(f.db.select().from(books).all()).toHaveLength(1);
  });

  it("refuses web pages and missing files without retrying", async () => {
    const page = (await start("https://files.local/page")).json().id;
    const missing = (await start("https://files.local/missing.epub")).json().id;
    await settle();
    const get = async (id: string) => (await f.app.inject({ url: `/api/admin/jobs/${id}`, headers: f.as("admin") })).json();
    expect(await get(page)).toMatchObject({ status: "failed", attempts: 1, lastError: "That link is a web page, not a book file" });
    expect(await get(missing)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("can be turned off", async () => {
    await put("admin", { direct: { enabled: false } });
    expect((await start("https://files.local/a.epub")).statusCode).toBe(409);
  });
});

describe("uploads", () => {
  const upload = (who: Who | null, filename: string, body: Buffer) =>
    f.app.inject({
      method: "PUT",
      url: `/api/uploads?filename=${encodeURIComponent(filename)}`,
      headers: { ...(who ? f.as(who) : {}), "content-type": "application/epub+zip" },
      payload: body,
    });

  it("lets admins upload a book into the inbox", async () => {
    const res = await upload("admin", "../../etc/Charlotte.epub", w.epub);
    expect(res.statusCode).toBe(201);
    expect(res.json().files[0]).toMatch(/^_incoming\/uploads\/[^/]+\/Charlotte\.epub$/);
    await f.app.jobs.drain();
    const [book] = f.db.select().from(books).all();
    expect(book).toMatchObject({ approved: false, title: "Charlotte's Web" });
  });

  it("is admin-only unless adults are allowed, and never for kids", async () => {
    expect((await upload(null, "a.epub", w.epub)).statusCode).toBe(401);
    expect((await upload("adult", "a.epub", w.epub)).statusCode).toBe(403);
    expect((await f.app.inject({ url: "/api/uploads/allowed", headers: f.as("adult") })).json()).toEqual({ allowed: false, maxMb: 500 });
    await put("admin", { uploads: { allowAdults: true } });
    expect((await upload("adult", "a.epub", w.epub)).statusCode).toBe(201);
    expect((await upload("parent", "b.epub", w.epub)).statusCode).toBe(201);
    expect((await upload("kid", "c.epub", w.epub)).statusCode).toBe(403);
  });

  it("refuses files that aren't books, and files over the limit", async () => {
    expect((await upload("admin", "virus.exe", Buffer.from("MZ"))).statusCode).toBe(415);
    await put("admin", { uploads: { maxMb: 1 } });
    expect((await upload("admin", "big.epub", Buffer.alloc(1024 * 1024 + 10))).statusCode).toBe(413);
    expect(f.db.select().from(books).all()).toHaveLength(0);
  });
});
