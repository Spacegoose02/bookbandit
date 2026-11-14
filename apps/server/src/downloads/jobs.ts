/**
 * The `downloads.fetch` job: get a book from Shelfmark, sabnzbd (via a Newznab indexer) or a
 * direct URL into BOOKS_DIR/_incoming, run a library scan so it lands in the admin inbox, and
 * report the new book ids back (to the request, when there is one).
 *
 * It's one job that moves through stages and saves its state in the payload, deferring while an
 * outside service works, so a restart picks up where it left off:
 *
 *   start → (shelfmark/sabnzbd) wait → fetch → import → done
 */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bookFiles } from "../db/schema.js";
import type { JobContext, JobRunner } from "../jobs/runner.js";
import { PermanentJobError } from "../jobs/runner.js";
import type { FetchLike } from "../metadata/providers/http.js";
import type { SecretBox } from "../integrations/secrets.js";
import {
  mapPath,
  NewznabClient,
  pickNzb,
  pickRelease,
  SabnzbdClient,
  ServiceError,
  ShelfmarkClient,
  type ShelfmarkBook,
} from "./clients.js";
import {
  filenameFromDisposition,
  filenameFromUrl,
  importFolder,
  NotABookError,
  placeDownload,
  TooLargeError,
  writeTemp,
} from "./incoming.js";
import { availableDownloaders, getDownloadSettings, type Downloader } from "./settings.js";

export const FETCH_JOB = "downloads.fetch";
export const SCAN_JOB = "library.scan";

export type Via = Downloader | "direct";

export interface FetchPayload {
  via: Via | "auto";
  /** Relative folder under BOOKS_DIR the files go to. */
  rel: string;
  requestId?: string;
  title?: string;
  author?: string | null;
  isbn13?: string | null;
  /** direct: the file URL. sabnzbd: an NZB URL (skips the indexer search). */
  url?: string;
  stage?: "start" | "wait" | "fetch" | "import";
  /** Downloaders already tried for an "auto" job. */
  tried?: Downloader[];
  /** The concrete downloader an "auto" job is on. */
  using?: Via;
  shelfmarkId?: string;
  nzoId?: string;
  waitingSince?: number;
  placed?: string[];
}

export interface FetchResult {
  via: Via;
  files: string[];
  bookIds: string[];
}

export interface DownloadHooks {
  /** A request's download moved on (for "downloading" status and progress). */
  onStarted?: (requestId: string, jobId: string) => void;
  onImported?: (requestId: string, result: FetchResult) => void;
  onFailed?: (requestId: string, error: string) => void;
}

export interface DownloadJobDeps {
  db: Db;
  box: SecretBox;
  booksDir: string;
  fetchImpl: FetchLike;
  hooks?: DownloadHooks;
  /** How long to wait between status checks. */
  pollMs?: { shelfmark: number; sabnzbd: number };
  /** Give up waiting on an outside service after this long. */
  maxWaitMs?: number;
}

/** Not found by this downloader: an "auto" job moves on to the next one. */
class NotFound extends Error {}

export function registerDownloadJobs(runner: JobRunner, deps: DownloadJobDeps): void {
  const poll = deps.pollMs ?? { shelfmark: 15_000, sabnzbd: 30_000 };
  const maxWait = deps.maxWaitMs ?? 48 * 3600_000;

  runner.register<FetchPayload>(
    FETCH_JOB,
    async (payload, ctx) => {
      const p: FetchPayload = { stage: "start", tried: [], ...payload };
      const save = () => ctx.update(p);
      const settings = getDownloadSettings(deps.db, deps.box);

      if (p.stage === "start") {
        if (p.requestId) deps.hooks?.onStarted?.(p.requestId, ctx.jobId);
        const order: Via[] =
          p.via === "auto" ? availableDownloaders(settings).filter((d) => !p.tried!.includes(d)) : [p.via];
        if (!order.length) {
          throw new PermanentJobError(
            p.tried!.length ? `Not found by ${p.tried!.join(" or ")}` : "No downloader is set up (Shelfmark, or sabnzbd with an indexer)",
          );
        }
        for (const via of order) {
          p.using = via;
          try {
            if (via === "direct") {
              if (!settings.direct.enabled) throw new PermanentJobError("Direct downloads are turned off");
              await direct(p, ctx, settings.direct.maxBytes);
              p.stage = "import";
            } else if (via === "shelfmark") {
              await startShelfmark(p, ctx, settings);
              p.stage = "wait";
            } else {
              await startSabnzbd(p, ctx, settings);
              p.stage = "wait";
            }
            p.waitingSince = Date.now();
            save();
            break;
          } catch (err) {
            if (err instanceof NotFound && p.via === "auto") {
              ctx.log(`${via}: ${err.message}`, "warn");
              p.tried!.push(via as Downloader);
              save();
              if (via === order[order.length - 1]) throw new PermanentJobError(`Not found by ${p.tried!.join(" or ")}`);
              continue;
            }
            if (err instanceof NotFound) throw new PermanentJobError(err.message);
            throw err;
          }
        }
      }

      if (p.stage === "wait") {
        const via = p.using!;
        if (Date.now() - (p.waitingSince ?? Date.now()) > maxWait) {
          throw new PermanentJobError(`${via} did not finish within ${Math.round(maxWait / 3600_000)} hours`);
        }
        const finished = via === "shelfmark" ? await waitShelfmark(p, ctx, settings) : await waitSabnzbd(p, ctx, settings, deps.booksDir);
        if (!finished) {
          save();
          ctx.defer(via === "shelfmark" ? poll.shelfmark : poll.sabnzbd);
        }
        p.stage = via === "shelfmark" ? "fetch" : "import";
        save();
      }

      if (p.stage === "fetch") {
        await fetchShelfmark(p, ctx, settings, deps.booksDir);
        p.stage = "import";
        save();
      }

      // import
      if (runner.has(SCAN_JOB)) {
        ctx.log("Scanning the library");
        await ctx.invoke(SCAN_JOB, { reason: "download" });
      } else {
        ctx.log("No library scanner is registered; the files will show up on the next scan", "warn");
      }
      const rows = deps.db
        .select({ bookId: bookFiles.bookId })
        .from(bookFiles)
        .where(sql`${bookFiles.relPath} like ${`${p.rel.replace(/[%_\\]/g, "\\$&")}/%`} escape '\\'`)
        .all();
      const bookIds = [...new Set(rows.map((r) => r.bookId))];
      const result: FetchResult = { via: p.using ?? (p.via as Via), files: p.placed ?? [], bookIds };
      if (!bookIds.length && p.placed?.length) {
        ctx.log("The files arrived but the scan did not add a book (DRM, or not readable). Check the scan report.", "warn");
      } else if (bookIds.length) {
        ctx.log(`In the inbox: ${bookIds.length} book${bookIds.length === 1 ? "" : "s"}`);
      }
      if (p.requestId) deps.hooks?.onImported?.(p.requestId, result);
      return result;

      // --- stages -------------------------------------------------------------

      async function direct(p: FetchPayload, ctx: JobContext, maxBytes: number) {
        if (!p.url) throw new PermanentJobError("No URL to download");
        ctx.log(`Downloading ${redact(p.url)}`);
        const res = await deps.fetchImpl(p.url, { redirect: "follow", signal: ctx.signal }).catch((err: unknown) => {
          if (ctx.signal.aborted) throw err;
          throw new Error(`Could not reach ${hostOf(p.url!)}: ${err instanceof Error ? err.message : String(err)}`);
        });
        if (res.status >= 400 && res.status < 500) throw new PermanentJobError(`${hostOf(p.url)} answered ${res.status}`);
        if (!res.ok || !res.body) throw new Error(`${hostOf(p.url)} answered ${res.status}`);
        const type = res.headers.get("content-type") ?? "";
        if (/^text\/html/i.test(type)) throw new PermanentJobError("That link is a web page, not a book file");
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (declared > maxBytes) throw new PermanentJobError(`The file is larger than ${Math.round(maxBytes / 1048576)} MB`);
        const name = filenameFromDisposition(res.headers.get("content-disposition")) ?? withExt(filenameFromUrl(res.url || p.url) ?? "book", type);
        await saveResponse(p, ctx, res, name, maxBytes);
      }

      async function saveResponse(p: FetchPayload, ctx: JobContext, res: Response, name: string, maxBytes: number) {
        try {
          const { tmp, bytes } = await writeTemp(deps.booksDir, res.body!, maxBytes, ctx.signal);
          p.placed = await placeDownload(deps.booksDir, tmp, p.rel, name);
          ctx.log(`Saved ${p.placed.join(", ")} (${Math.round(bytes / 1024)} KB)`);
        } catch (err) {
          if (err instanceof TooLargeError || err instanceof NotABookError) throw new PermanentJobError(err.message);
          throw err;
        }
      }

      async function startShelfmark(p: FetchPayload, ctx: JobContext, s: typeof settings) {
        if (!s.shelfmark?.enabled) throw new NotFound("Shelfmark is not set up");
        const sm = new ShelfmarkClient(s.shelfmark, deps.fetchImpl);
        const query = p.isbn13 || [p.title, p.author].filter(Boolean).join(" ");
        if (!query) throw new PermanentJobError("Nothing to search for");
        ctx.log(`Shelfmark: searching for "${query}"`);
        let books = await sm.searchBooks(query, ctx.signal);
        if (!books.length && p.isbn13 && p.title) {
          ctx.log(`Shelfmark: nothing for the ISBN; searching for "${p.title}"`);
          books = await sm.searchBooks([p.title, p.author].filter(Boolean).join(" "), ctx.signal);
        }
        const book = bestBook(books, p);
        if (!book) throw new NotFound("Shelfmark found no matching book");
        ctx.log(`Shelfmark: found "${book.title}"${book.authors?.length ? ` by ${book.authors.join(", ")}` : ""} (${book.provider})`);
        const releases = await sm.releases(book, ctx.signal);
        const release = pickRelease(releases);
        if (!release) throw new NotFound(`Shelfmark found ${releases.length} release(s) but none in a format Bookbandit reads`);
        ctx.log(`Shelfmark: queueing ${release.format ?? "file"} from ${release.source}${release.size ? ` (${release.size})` : ""}`);
        await sm.queue(release, ctx.signal);
        p.shelfmarkId = release.source_id;
      }

      async function waitShelfmark(p: FetchPayload, ctx: JobContext, s: typeof settings): Promise<boolean> {
        if (!s.shelfmark) throw new PermanentJobError("Shelfmark was removed from the settings");
        const sm = new ShelfmarkClient(s.shelfmark, deps.fetchImpl);
        const t = await sm.task(p.shelfmarkId!, ctx.signal);
        if (!t) throw new PermanentJobError("Shelfmark no longer has this download");
        if (t.state === "complete") {
          ctx.log("Shelfmark: download complete");
          return true;
        }
        if (t.state === "error" || t.state === "cancelled") {
          throw new PermanentJobError(`Shelfmark: ${t.task.status_message || t.state}`);
        }
        if (typeof t.task.progress === "number") ctx.progress(Math.min(0.9, t.task.progress / 100));
        return false;
      }

      async function fetchShelfmark(p: FetchPayload, ctx: JobContext, s: typeof settings, _booksDir: string) {
        if (!s.shelfmark) throw new PermanentJobError("Shelfmark was removed from the settings");
        const sm = new ShelfmarkClient(s.shelfmark, deps.fetchImpl);
        const res = await sm.file(p.shelfmarkId!, ctx.signal);
        if (!res.body) throw new Error("Shelfmark sent an empty file");
        const name =
          filenameFromDisposition(res.headers.get("content-disposition")) ??
          withExt(p.title ?? "book", res.headers.get("content-type") ?? "");
        await saveResponse(p, ctx, res, name, Number.MAX_SAFE_INTEGER);
      }

      async function startSabnzbd(p: FetchPayload, ctx: JobContext, s: typeof settings) {
        if (!s.sabnzbd?.enabled) throw new NotFound("sabnzbd is not set up");
        const sab = new SabnzbdClient(s.sabnzbd, deps.fetchImpl);
        let nzbUrl = p.url;
        if (!nzbUrl) {
          if (!s.newznab?.enabled) throw new NotFound("No Newznab indexer is set up to find NZBs");
          const nz = new NewznabClient(s.newznab, deps.fetchImpl);
          const query = [p.title, p.author].filter(Boolean).join(" ");
          ctx.log(`Indexer: searching for "${query}"`);
          const results = await nz.search(query, ctx.signal);
          const pick = pickNzb(results, p.title ?? "", p.author);
          if (!pick) throw new NotFound(`The indexer found no matching NZB (${results.length} results)`);
          ctx.log(`Indexer: picked "${pick.title}"`);
          nzbUrl = pick.link;
        }
        p.nzoId = await sab.addUrl(nzbUrl, p.title ?? "book", ctx.signal);
        ctx.log(`sabnzbd: queued as ${p.nzoId}`);
      }

      async function waitSabnzbd(p: FetchPayload, ctx: JobContext, s: typeof settings, booksDir: string): Promise<boolean> {
        if (!s.sabnzbd) throw new PermanentJobError("sabnzbd was removed from the settings");
        const sab = new SabnzbdClient(s.sabnzbd, deps.fetchImpl);
        const slot = await sab.queueSlot(p.nzoId!, ctx.signal);
        if (slot) {
          const pct = Number(slot.percentage);
          if (Number.isFinite(pct)) ctx.progress(Math.min(0.9, pct / 100));
          return false;
        }
        const h = await sab.historySlot(p.nzoId!, ctx.signal);
        if (!h) throw new PermanentJobError("sabnzbd no longer has this download");
        if (h.status === "Failed") throw new PermanentJobError(`sabnzbd: ${h.fail_message || "download failed"}`);
        if (h.status !== "Completed") return false; // Verifying, Repairing, Extracting, Moving …
        if (!h.storage) throw new PermanentJobError("sabnzbd finished but did not say where the files are");
        const from = mapPath(h.storage, s.sabnzbd.pathMap);
        ctx.log(`sabnzbd: complete in ${h.storage}${from !== h.storage ? ` (here: ${from})` : ""}`);
        try {
          p.placed = await importFolder(booksDir, from, p.rel);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new PermanentJobError(`Can't see ${from}. Mount sabnzbd's completed folder and set the path map.`);
          }
          throw err;
        }
        if (!p.placed.length) throw new PermanentJobError("The download had no book files in it");
        ctx.log(`Copied ${p.placed.join(", ")}`);
        return true;
      }
    },
    {
      maxAttempts: 4,
      onFailed: (payload, error) => {
        if (payload.requestId) deps.hooks?.onFailed?.(payload.requestId, error);
      },
      onCancelled: (payload) => {
        if (payload.requestId) deps.hooks?.onFailed?.(payload.requestId, "Download cancelled");
      },
    },
  );
}

function bestBook(books: ShelfmarkBook[], p: FetchPayload): ShelfmarkBook | undefined {
  if (p.isbn13) {
    const exact = books.find((b) => b.isbn_13 === p.isbn13);
    if (exact) return exact;
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (p.title) {
    const want = norm(p.title);
    const same = books.filter((b) => norm(b.title) === want || norm(b.title).startsWith(`${want} `));
    if (p.author) {
      const last = norm(p.author).split(" ").pop() ?? "";
      const byAuthor = same.find((b) => b.authors?.some((a) => norm(a).includes(last)));
      if (byAuthor) return byAuthor;
    }
    if (same[0]) return same[0];
  }
  return p.isbn13 ? books[0] : undefined;
}

const EXT_BY_TYPE: Record<string, string> = {
  "application/epub+zip": ".epub",
  "application/pdf": ".pdf",
  "application/x-mobipocket-ebook": ".mobi",
  "application/vnd.amazon.ebook": ".azw3",
  "application/vnd.comicbook+zip": ".cbz",
  "application/x-cbz": ".cbz",
  "application/zip": ".zip",
  "application/x-fictionbook+xml": ".fb2",
};

function withExt(name: string, contentType: string): string {
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  return name + (EXT_BY_TYPE[contentType.split(";")[0]!.trim().toLowerCase()] ?? "");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the server";
  }
}

/** Don't write tokens in query strings to the log. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/key|token|pass|auth|sig/i.test(k)) u.searchParams.set(k, "…");
    }
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

export { ServiceError };
