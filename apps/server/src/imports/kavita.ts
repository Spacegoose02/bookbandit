/**
 * Kavita import through its API: read progress and collections, per person.
 *
 * Kavita keeps progress per user and an API key belongs to one user, so the admin pastes one
 * API key per person (Kavita → User settings → 3rd party clients / API key). We sign in with
 * `POST /api/Plugin/authenticate`, list series with `POST /api/Series/all-v2`, read volumes
 * and chapters (pages read, file paths) with `GET /api/Series/volumes`, and collections with
 * `GET /api/Collection` + `GET /api/Series/series-by-collection`.
 *
 * Kavita's files are matched to scanned files by path tail and size, like Calibre's.
 */
import type { Db } from "../db/client.js";
import { books } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { FetchLike } from "../metadata/providers/http.js";
import { USER_AGENT } from "../metadata/providers/http.js";
import {
  addToCollection,
  ensureCollection,
  FileIndex,
  importProgress,
  parseDate,
  person,
  upsertHistory,
  writeOrRollBack,
  type Reporter,
  type SourcePerson,
} from "./common.js";

export interface KavitaChapter {
  id: number;
  pages: number;
  pagesRead: number;
  lastRead: number | null;
  files: { path: string; bytes: number | null; pages: number }[];
}

export interface KavitaAccount {
  /** Index of the API key in the admin's list. */
  key: string;
  username: string;
  userId: string | null;
  series: { id: number; name: string; chapters: KavitaChapter[] }[];
  collections: { id: number; name: string; seriesIds: number[] }[];
  /** All chapters of series in a collection, so their books can be found. */
  collectionChapters: Map<number, KavitaChapter[]>;
}

const PAGE = 200;

class KavitaClient {
  private token = "";
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly base: string,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) throw new Error("Kavita didn't accept this API key");
    if (!res.ok) throw new Error(`Kavita answered ${res.status} for ${path.split("?")[0]}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async signIn(apiKey: string): Promise<string> {
    const q = new URLSearchParams({ apiKey, pluginName: "Bookbandit" });
    const me = await this.call<{ username?: string; token?: string }>("POST", `/api/Plugin/authenticate?${q}`);
    if (!me?.token) throw new Error("Kavita didn't return a sign-in token");
    this.token = me.token;
    return me.username ?? "Kavita user";
  }

  async allSeries(): Promise<{ id: number; name: string; pagesRead: number }[]> {
    const out: { id: number; name: string; pagesRead: number }[] = [];
    for (let page = 1; page < 500; page++) {
      const rows = await this.call<{ id: number; name?: string; pagesRead?: number }[]>(
        "POST",
        `/api/Series/all-v2?PageNumber=${page}&PageSize=${PAGE}`,
        { statements: [], combination: 1, limitTo: 0, sortOptions: { sortField: 1, isAscending: true } },
      );
      for (const r of rows ?? []) out.push({ id: r.id, name: r.name ?? `Series ${r.id}`, pagesRead: r.pagesRead ?? 0 });
      if (!rows || rows.length < PAGE) break;
    }
    return out;
  }

  async chapters(seriesId: number): Promise<KavitaChapter[]> {
    type Ch = { id: number; pages?: number; pagesRead?: number; lastReadingProgressUtc?: string; files?: { filePath?: string; bytes?: number; pages?: number }[] };
    const vols = await this.call<{ chapters?: Ch[] }[]>("GET", `/api/Series/volumes?seriesId=${seriesId}`);
    return (vols ?? []).flatMap((v) =>
      (v.chapters ?? []).map((c) => {
        const last = parseDate(c.lastReadingProgressUtc ?? null);
        return {
          id: c.id,
          pages: c.pages ?? 0,
          pagesRead: c.pagesRead ?? 0,
          // Kavita uses 0001-01-01 for "never".
          lastRead: last && last > Date.UTC(1971, 0, 1) ? last : null,
          files: (c.files ?? []).filter((f) => f.filePath).map((f) => ({ path: f.filePath!, bytes: f.bytes ?? null, pages: f.pages ?? 0 })),
        };
      }),
    );
  }

  async collections(): Promise<{ id: number; name: string; seriesIds: number[] }[]> {
    const tags = await this.call<{ id: number; title?: string; name?: string }[]>("GET", "/api/Collection");
    const out: { id: number; name: string; seriesIds: number[] }[] = [];
    for (const t of tags ?? []) {
      const seriesIds: number[] = [];
      for (let page = 1; page < 100; page++) {
        const rows = await this.call<{ id: number }[]>("GET", `/api/Series/series-by-collection?collectionId=${t.id}&PageNumber=${page}&PageSize=${PAGE}`);
        seriesIds.push(...(rows ?? []).map((r) => r.id));
        if (!rows || rows.length < PAGE) break;
      }
      out.push({ id: t.id, name: t.title ?? t.name ?? `Collection ${t.id}`, seriesIds });
    }
    return out;
  }
}

export function kavitaBase(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Kavita URL must start with http:// or https://");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Reads everything we need from Kavita for each account. Network only, no database writes. */
export async function fetchKavita(
  fetchFn: FetchLike,
  url: string,
  keys: { apiKey: string; userId: string | null }[],
  report: Reporter,
  progress: (f: number) => void = () => {},
): Promise<KavitaAccount[]> {
  const base = kavitaBase(url);
  const accounts: KavitaAccount[] = [];
  for (const [i, k] of keys.entries()) {
    const client = new KavitaClient(fetchFn, base);
    let username: string;
    try {
      username = await client.signIn(k.apiKey);
    } catch (e) {
      report.warn(`API key ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const all = await client.allSeries();
    const started = all.filter((s) => s.pagesRead > 0);
    const series: KavitaAccount["series"] = [];
    for (const [j, s] of started.entries()) {
      progress((i + j / Math.max(1, started.length) / 2) / keys.length);
      series.push({ id: s.id, name: s.name, chapters: await client.chapters(s.id) });
    }
    const collections = await client.collections().catch((e: unknown) => {
      report.warn(`${username}: couldn't read collections (${e instanceof Error ? e.message : String(e)})`);
      return [];
    });
    const collectionChapters = new Map<number, KavitaChapter[]>();
    const known = new Map(series.map((s) => [s.id, s.chapters]));
    for (const id of new Set(collections.flatMap((c) => c.seriesIds))) {
      collectionChapters.set(id, known.get(id) ?? (await client.chapters(id).catch(() => [])));
    }
    accounts.push({ key: String(i), username, userId: k.userId, series, collections, collectionChapters });
  }
  progress(1);
  return accounts;
}

const PAGE_FORMATS = new Set(["pdf", "cbz", "cbr"]);

export async function importKavita(
  db: Db,
  accounts: KavitaAccount[],
  people: SourcePerson[],
  opts: { dryRun: boolean; collections: boolean },
  report: Reporter,
): Promise<void> {
  report.report.people = people;
  const mapped = new Map(people.filter((p) => p.userId).map((p) => [p.id, p.userId!]));
  await writeOrRollBack(db, opts.dryRun, (tx) => {
    const index = new FileIndex(tx);
    const find = (c: KavitaChapter) => c.files.map((f) => index.byPath(f.path, f.bytes ?? undefined)).find(Boolean);
    for (const acc of accounts) {
      const userId = mapped.get(acc.key);
      if (!userId) {
        report.add("skipped", `Kavita user ${acc.username}`, "Not matched to anyone in Bookbandit.");
        continue;
      }
      for (const s of acc.series) {
        for (const c of s.chapters) {
          if (c.pagesRead <= 0 || c.pages <= 0) continue;
          const hit = find(c);
          const label = `${acc.username}: ${s.name}${s.chapters.length > 1 ? ` (#${c.id})` : ""}`;
          if (!hit) {
            report.add("skipped", label, `No matching file in Bookbandit (${c.files[0]?.path ?? "no file"})`);
            continue;
          }
          const title = tx.select({ t: books.title }).from(books).where(eq(books.id, hit.bookId)).get()?.t ?? s.name;
          const finished = c.pagesRead >= c.pages;
          const percent = Math.min(1, c.pagesRead / c.pages);
          const at = c.lastRead ?? Date.now();
          const locator = PAGE_FORMATS.has(hit.format)
            ? { kind: "page" as const, page: Math.max(0, Math.min(c.pages - 1, c.pagesRead - 1)), totalPages: c.pages }
            : undefined;
          const prog = importProgress(tx, userId, hit.bookId, { percent, finished, at, locator, deviceName: "Kavita" });
          if (finished) {
            upsertHistory(tx, { userId, bookId: hit.bookId, title, status: "read", finishedAt: c.lastRead, source: "kavita", sourceKey: `chapter:${c.id}` });
          }
          const name = `${acc.username}: ${title}`;
          if (prog === "kept-newer") report.add("conflict", name, "Bookbandit has a newer position; kept it.");
          else if (prog === "written") report.add("matched", name, finished ? "Finished" : `${Math.round(percent * 100)}%`);
          else report.add("skipped", name, "Already up to date.");
        }
      }
      if (!opts.collections) continue;
      const owner = person(tx, userId);
      if (!owner) continue;
      for (const col of acc.collections) {
        const bookIds = new Set<string>();
        for (const sid of col.seriesIds) for (const c of acc.collectionChapters.get(sid) ?? []) {
          const hit = find(c);
          if (hit) bookIds.add(hit.bookId);
        }
        if (!bookIds.size) {
          report.add("skipped", `Collection "${col.name}" (${acc.username})`, "None of its books are in Bookbandit.");
          continue;
        }
        const id = ensureCollection(tx, owner.householdId, userId, col.name, report);
        let added = 0;
        for (const b of bookIds) if (addToCollection(tx, id, b)) added++;
        report.stat("books put in collections", added);
        report.add(added ? "new" : "skipped", `Collection "${col.name}" (${acc.username})`, `${added} books added`);
      }
    }
  });
}
