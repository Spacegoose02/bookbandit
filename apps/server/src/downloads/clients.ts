/**
 * HTTP clients for the downloaders. Each takes a fetch so tests can fake the service.
 *
 * - Shelfmark: https://github.com/calibrain/shelfmark (docs/api-access.md). Search metadata,
 *   list releases, queue one, poll /api/status, fetch the file with /api/localdownload.
 * - sabnzbd: https://sabnzbd.org/wiki/configuration/4.3/api (addurl, queue, history).
 * - Newznab: the indexer API sabnzbd users already have (t=search / t=book).
 */
import { XMLParser } from "fast-xml-parser";
import { USER_AGENT, type FetchLike } from "../metadata/providers/http.js";
import type { NewznabSettings, SabnzbdSettings, ShelfmarkSettings } from "./settings.js";

const TIMEOUT = 30_000;

export class ServiceError extends Error {}

async function call(fetchFn: FetchLike, url: string, init: RequestInit & { service: string }): Promise<Response> {
  const { service, ...rest } = init;
  let res: Response;
  try {
    res = await fetchFn(url, {
      ...rest,
      headers: { "user-agent": USER_AGENT, ...(rest.headers ?? {}) },
      signal: rest.signal ?? AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    if ((rest.signal as AbortSignal | undefined)?.aborted) throw err;
    throw new ServiceError(`${service} is unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401 || res.status === 403) throw new ServiceError(`${service} refused the API key (${res.status})`);
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = `: ${body.error}`;
    } catch {
      /* not JSON */
    }
    throw new ServiceError(`${service} answered ${res.status}${detail}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Shelfmark
// ---------------------------------------------------------------------------

export interface ShelfmarkBook {
  provider: string;
  provider_id: string;
  title: string;
  authors?: string[];
  isbn_13?: string | null;
  publish_year?: number | null;
  cover_url?: string | null;
}

export interface ShelfmarkRelease {
  source: string;
  source_id: string;
  title: string;
  format?: string | null;
  language?: string | null;
  size?: string | null;
  size_bytes?: number | null;
  content_type?: string | null;
  [k: string]: unknown;
}

export interface ShelfmarkTask {
  id: string;
  title?: string;
  status?: string;
  status_message?: string | null;
  progress?: number | null;
  download_path?: string | null;
}

export type ShelfmarkState = "queued" | "resolving" | "locating" | "downloading" | "complete" | "error" | "cancelled";

export class ShelfmarkClient {
  constructor(
    private readonly s: ShelfmarkSettings,
    private readonly fetchFn: FetchLike,
  ) {}

  private headers(): Record<string, string> {
    return { "x-api-key": this.s.apiKey, accept: "application/json" };
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await call(this.fetchFn, `${this.s.url}${path}`, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) }, service: "Shelfmark" });
    return (await res.json()) as T;
  }

  /** Checks the URL and key. */
  async test(): Promise<void> {
    await this.json("/api/status");
  }

  async searchBooks(query: string, signal?: AbortSignal): Promise<ShelfmarkBook[]> {
    const params = new URLSearchParams({ query, content_type: "ebook", limit: "10" });
    if (this.s.provider) params.set("provider", this.s.provider);
    const r = await this.json<{ books?: ShelfmarkBook[] }>(`/api/metadata/search?${params}`, { signal });
    return r.books ?? [];
  }

  async releases(book: ShelfmarkBook, signal?: AbortSignal): Promise<ShelfmarkRelease[]> {
    const params = new URLSearchParams({
      provider: book.provider,
      book_id: book.provider_id,
      content_type: "ebook",
      title: book.title,
    });
    if (book.authors?.[0]) params.set("author", book.authors[0]);
    const r = await this.json<{ releases?: ShelfmarkRelease[] }>(`/api/releases?${params}`, { signal });
    return r.releases ?? [];
  }

  async queue(release: ShelfmarkRelease, signal?: AbortSignal): Promise<void> {
    await this.json("/api/releases/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(release),
      signal,
    });
  }

  /** The task with this id and the queue bucket it's in, or null when Shelfmark doesn't know it. */
  async task(id: string, signal?: AbortSignal): Promise<{ state: ShelfmarkState; task: ShelfmarkTask } | null> {
    const status = await this.json<Record<string, Record<string, ShelfmarkTask>>>("/api/status", { signal });
    for (const [state, tasks] of Object.entries(status ?? {})) {
      const t = tasks?.[id];
      if (t) return { state: state as ShelfmarkState, task: t };
    }
    return null;
  }

  /** The finished file (or a zip of several). */
  async file(id: string, signal?: AbortSignal): Promise<Response> {
    return call(this.fetchFn, `${this.s.url}/api/localdownload?${new URLSearchParams({ id })}`, {
      headers: { "x-api-key": this.s.apiKey },
      signal: signal ?? AbortSignal.timeout(30 * 60_000),
      service: "Shelfmark",
    });
  }
}

const FORMAT_PREFERENCE = ["epub", "azw3", "mobi", "pdf", "fb2", "cbz", "cbr", "txt"];

/** The release to download: a format we read (EPUB first), English if marked, then the source's order. */
export function pickRelease(releases: ShelfmarkRelease[], language = "en"): ShelfmarkRelease | undefined {
  const score = (r: ShelfmarkRelease) => {
    const fmt = (r.format ?? "").toLowerCase();
    const f = FORMAT_PREFERENCE.indexOf(fmt);
    const lang = r.language && r.language.toLowerCase() !== language ? 1 : 0;
    return (f === -1 ? 100 : f) * 10 + lang;
  };
  const usable = releases.filter((r) => r.source && r.source_id && (r.content_type ?? "ebook") === "ebook");
  const readable = usable.filter((r) => !r.format || FORMAT_PREFERENCE.includes(r.format.toLowerCase()));
  return readable
    .map((r, i) => ({ r, i, s: score(r) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)[0]?.r;
}

// ---------------------------------------------------------------------------
// sabnzbd
// ---------------------------------------------------------------------------

export interface SabSlot {
  nzo_id: string;
  status: string;
  percentage?: string;
  filename?: string;
  timeleft?: string;
}

export interface SabHistorySlot {
  nzo_id: string;
  status: string;
  storage?: string | null;
  fail_message?: string;
  name?: string;
}

export class SabnzbdClient {
  constructor(
    private readonly s: SabnzbdSettings,
    private readonly fetchFn: FetchLike,
  ) {}

  private async api<T>(params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const q = new URLSearchParams({ ...params, apikey: this.s.apiKey, output: "json" });
    const res = await call(this.fetchFn, `${this.s.url}/api?${q}`, { signal, service: "sabnzbd" });
    const body = (await res.json()) as T & { status?: boolean; error?: string };
    if (body && typeof body === "object" && body.status === false) throw new ServiceError(`sabnzbd: ${body.error ?? "request failed"}`);
    return body;
  }

  async test(): Promise<string> {
    // `version` needs no key; `queue` checks the key too.
    await this.api({ mode: "queue", limit: "1" });
    const v = await this.api<{ version?: string }>({ mode: "version" });
    return v.version ?? "unknown";
  }

  async addUrl(nzbUrl: string, name: string, signal?: AbortSignal): Promise<string> {
    const r = await this.api<{ nzo_ids?: string[] }>({ mode: "addurl", name: nzbUrl, nzbname: name, cat: this.s.category }, signal);
    const id = r.nzo_ids?.[0];
    if (!id) throw new ServiceError("sabnzbd did not accept the NZB");
    return id;
  }

  async queueSlot(nzoId: string, signal?: AbortSignal): Promise<SabSlot | undefined> {
    const r = await this.api<{ queue?: { slots?: SabSlot[] } }>({ mode: "queue", nzo_ids: nzoId }, signal);
    return r.queue?.slots?.find((s) => s.nzo_id === nzoId);
  }

  async historySlot(nzoId: string, signal?: AbortSignal): Promise<SabHistorySlot | undefined> {
    const r = await this.api<{ history?: { slots?: SabHistorySlot[] } }>({ mode: "history", nzo_ids: nzoId }, signal);
    return r.history?.slots?.find((s) => s.nzo_id === nzoId);
  }
}

/** sabnzbd's path for a finished job, as this container sees it. */
export function mapPath(path: string, map: SabnzbdSettings["pathMap"]): string {
  if (!map) return path;
  const from = map.from.replace(/\/+$/, "");
  if (path === from || path.startsWith(`${from}/`)) return map.to.replace(/\/+$/, "") + path.slice(from.length);
  return path;
}

// ---------------------------------------------------------------------------
// Newznab
// ---------------------------------------------------------------------------

export interface NzbResult {
  title: string;
  link: string;
  size?: number;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });

export class NewznabClient {
  constructor(
    private readonly s: NewznabSettings,
    private readonly fetchFn: FetchLike,
  ) {}

  async search(query: string, signal?: AbortSignal): Promise<NzbResult[]> {
    const base = /\/api$/.test(this.s.url) ? this.s.url : `${this.s.url}/api`;
    const q = new URLSearchParams({ t: "search", q: query, cat: this.s.categories, apikey: this.s.apiKey, limit: "50" });
    const res = await call(this.fetchFn, `${base}?${q}`, { signal, service: "Newznab indexer" });
    const doc = xml.parse(await res.text()) as {
      error?: { "@description"?: string };
      rss?: { channel?: { item?: RawItem | RawItem[] } };
    };
    if (doc.error) throw new ServiceError(`Newznab indexer: ${doc.error["@description"] ?? "error"}`);
    const raw = doc.rss?.channel?.item;
    const items = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    return items
      .map((i) => ({
        title: String(i.title ?? ""),
        link: String(i.enclosure?.["@url"] ?? i.link ?? ""),
        size: Number(i.enclosure?.["@length"] ?? 0) || undefined,
      }))
      .filter((i) => i.title && /^https?:\/\//.test(i.link));
  }
}

interface RawItem {
  title?: unknown;
  link?: unknown;
  enclosure?: { "@url"?: string; "@length"?: string };
}

/** The NZB whose title best matches: every title word present, EPUB preferred, smaller first. */
export function pickNzb(results: NzbResult[], title: string, author?: string | null): NzbResult | undefined {
  const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length > 1);
  const need = words(title).filter((w) => !["the", "a", "an", "of", "and"].includes(w));
  const authorWords = author ? words(author).slice(-1) : [];
  const ok = results.filter((r) => {
    const have = new Set(words(r.title));
    return need.length > 0 && need.every((w) => have.has(w));
  });
  const byAuthor = (r: NzbResult) => {
    const have = new Set(words(r.title));
    return authorWords.every((w) => have.has(w)) ? 0 : 1;
  };
  const epubFirst = (r: NzbResult) => (/\bepub\b/i.test(r.title) ? 0 : 1);
  return ok.sort((a, b) => byAuthor(a) - byAuthor(b) || epubFirst(a) - epubFirst(b) || (a.size ?? Infinity) - (b.size ?? Infinity))[0];
}
