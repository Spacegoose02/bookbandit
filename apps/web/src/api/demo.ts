/**
 * In-browser sample data so the UI can be developed, demoed and screenshotted without a server.
 * Never used in production builds unless `?demo` is in the URL. Respects the same rating rules
 * as the server so kid mode looks right.
 */
import { locatorPercent, ratingRank, UNRATED_FALLBACK, type ContentRating, type ProgressUpdate } from "@bookbandit/shared";
import type { Api } from "./client";
import type { Bookmark, BookDetail, BookSummary, Me, NewBookmark, Page, ProgressRecord, Shelf } from "./types";

const ADULT: Me = {
  id: "u-adult",
  displayName: "Sam",
  role: "parent",
  isKid: false,
  avatar: null,
  theme: "dark",
  maxRating: "adult",
};

const KID: Me = {
  id: "u-kid",
  displayName: "Mia",
  role: "kid",
  isKid: true,
  avatar: "🦖",
  theme: "dinosaur",
  maxRating: "kids",
};

const PALETTE = ["#e76f51", "#2a9d8f", "#264653", "#e9c46a", "#8338ec", "#ff006e", "#3a86ff", "#06d6a0", "#8d6e63"];

function coverSvg(title: string, author: string, i: number): string {
  const bg = PALETTE[i % PALETTE.length];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const words = title.split(" ");
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + " " + w).length <= 12) lines[lines.length - 1] = last + " " + w;
    else lines.push(w);
  }
  const text = lines
    .slice(0, 4)
    .map((l, n) => `<text x="100" y="${90 + n * 34}" text-anchor="middle">${esc(l)}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="${bg}"/><rect x="12" y="12" width="176" height="276" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="2"/><g font-family="Georgia,serif" font-size="26" font-weight="700" fill="#fff">${text}</g><text x="100" y="262" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#fff" fill-opacity=".85">${esc(author)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

interface DemoBook extends BookDetail {
  added: number;
}

const RAW: [string, string, number, ContentRating | null, string?, number?][] = [
  ["The Dinosaur Who Loved Books", "Pip Harlow", 2021, "kids", "Dino Readers", 1],
  ["Dino Goes to School", "Pip Harlow", 2022, "kids", "Dino Readers", 2],
  ["Barnaby and the Missing Page", "Juniper Vale", 2023, "kids"],
  ["Storm Over Pebble Bay", "Ada Brightwater", 2019, "middle_grade", "Pebble Bay", 1],
  ["Secrets of Pebble Bay", "Ada Brightwater", 2020, "middle_grade", "Pebble Bay", 2],
  ["The Robot Next Door", "Kenji Morrow", 2018, "middle_grade"],
  ["Pixel Quest", "Rae Okafor", 2024, "teen", "Pixel Quest", 1],
  ["Pixel Quest: Level Two", "Rae Okafor", 2025, "teen", "Pixel Quest", 2],
  ["The Lighthouse Keeper", "Margot Lindqvist", 1998, "adult"],
  ["Gardens of Ash", "Thomas Reyes", 2005, "adult"],
  ["A Quiet Year in Kyoto", "Hana Mori", 2016, "adult"],
  ["Weeknight Soups", "Lena Park", 2022, "adult"],
  ["The Long Winter Road", "Margot Lindqvist", 1987, "adult"],
  ["Untitled Manuscript", "Unknown", 2010, null],
];

const BOOKS: DemoBook[] = RAW.map(([title, author, year, rating, series, pos], i) => ({
  id: `b${i + 1}`,
  title,
  subtitle: null,
  description:
    "A sample book that only exists in demo mode. Real books come from your /books folder once the server is running.",
  language: "en",
  publisher: "Demo Press",
  pageCount: 120 + i * 17,
  publishedYear: year,
  rating,
  coverPath: coverSvg(title, author, i),
  kindleOnly: i === 10,
  kindleAsin: i === 10 ? "B000DEMO00" : null,
  absItemId: null,
  authors: [{ id: `a-${author}`, name: author }],
  series: series ? [{ id: `series:${series}`, name: series, position: pos ?? null }] : [],
  files: i === 10 ? [] : [{ id: `f${i + 1}`, format: "epub", sizeBytes: 120_000 }],
  added: Date.UTC(2026, 10, 14) - i * 86_400_000,
}));

function who(): Me {
  try {
    const p = new URLSearchParams(window.location.search).get("demo");
    if (p === "kid" || p === "adult") sessionStorage.setItem("bb-demo-user", p);
    const saved = sessionStorage.getItem("bb-demo-user");
    const base = saved === "kid" ? KID : ADULT;
    const theme = localStorage.getItem(`bb-demo-theme-${base.id}`);
    return theme ? { ...base, theme: theme as Me["theme"] } : base;
  } catch {
    return ADULT;
  }
}

function visible(me: Me): DemoBook[] {
  return BOOKS.filter((b) => ratingRank(b.rating ?? UNRATED_FALLBACK) <= ratingRank(me.maxRating));
}

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};

const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));

function summary(b: DemoBook, me: Me): BookSummary {
  const p = store.get<ProgressRecord | null>(`bb-demo-progress-${me.id}-${b.id}`, null);
  const { id, title, publishedYear, rating, coverPath, kindleOnly, authors, series } = b;
  return { id, title, publishedYear, rating, coverPath, kindleOnly, authors, series, percent: p?.percent ?? null };
}

function notFound(): never {
  const e = new Error("Not found") as Error & { status: number; notFound: boolean };
  e.status = 404;
  e.notFound = true;
  throw e;
}

function saveProgress(u: ProgressUpdate): ProgressRecord {
  const percent = locatorPercent(u.locator);
  const record: ProgressRecord = {
    bookId: u.bookId,
    locator: u.locator,
    percent,
    finished: u.finished ?? percent >= 0.99,
    deviceName: u.deviceName,
    clientUpdatedAt: Date.parse(u.updatedAt),
    serverUpdatedAt: Date.now(),
  };
  store.set(`bb-demo-progress-${who().id}-${u.bookId}`, record);
  return record;
}

export const demoApi: Api = {
  me: () => delay(who()),
  async setTheme(theme) {
    try {
      localStorage.setItem(`bb-demo-theme-${who().id}`, theme);
    } catch {
      /* ignore */
    }
  },
  async shelves() {
    const me = who();
    const books = visible(me);
    const started = books.filter((b) => store.get(`bb-demo-progress-${me.id}-${b.id}`, null));
    const shelves: Shelf[] = [];
    if (started.length) shelves.push({ id: "continue", name: "Keep reading", kind: "continue", books: started.map((b) => summary(b, me)) });
    if (me.isKid) {
      shelves.push({ id: "kid", name: "My books", kind: "kid", books: books.map((b) => summary(b, me)) });
    } else {
      shelves.push({ id: "recent", name: "Recently added", kind: "recent", books: [...books].sort((a, b) => b.added - a.added).slice(0, 8).map((b) => summary(b, me)) });
      const series = new Map<string, DemoBook[]>();
      for (const b of books) for (const s of b.series ?? []) series.set(s.name, [...(series.get(s.name) ?? []), b]);
      for (const [name, list] of series) shelves.push({ id: `series:${name}`, name, kind: "series", books: list.map((b) => summary(b, me)) });
    }
    return delay(shelves);
  },
  async books(query) {
    const me = who();
    const q = (query.get("q") ?? "").toLowerCase();
    const author = (query.get("author") ?? "").toLowerCase();
    const from = Number(query.get("yearFrom") ?? -Infinity);
    const to = Number(query.get("yearTo") ?? Infinity);
    const ratings = query.get("ratings")?.split(",") ?? [];
    const shelf = query.get("shelf") ?? "";
    const sort = query.get("sort") ?? "title";
    let list = visible(me).filter(
      (b) =>
        (!q || b.title.toLowerCase().includes(q) || b.authors?.some((a) => a.name.toLowerCase().includes(q))) &&
        (!author || b.authors?.some((a) => a.name.toLowerCase().includes(author))) &&
        (b.publishedYear == null || (b.publishedYear >= from && b.publishedYear <= to)) &&
        (!ratings.length || ratings.includes(b.rating ?? "adult")) &&
        (!shelf || shelf === "kid" || b.series?.some((s) => s.id === shelf)),
    );
    const by: Record<string, (a: DemoBook, b: DemoBook) => number> = {
      title: (a, b) => a.title.localeCompare(b.title),
      author: (a, b) => (a.authors?.[0]?.name ?? "").localeCompare(b.authors?.[0]?.name ?? ""),
      year: (a, b) => (b.publishedYear ?? 0) - (a.publishedYear ?? 0),
      added: (a, b) => b.added - a.added,
    };
    list = [...list].sort(by[sort] ?? by.title);
    const limit = Number(query.get("limit") ?? 50);
    const offset = Number(query.get("offset") ?? 0);
    const page: Page<BookSummary> = { items: list.slice(offset, offset + limit).map((b) => summary(b, me)), limit, offset, total: list.length };
    return delay(page);
  },
  async authors(q) {
    const names = [...new Set(visible(who()).flatMap((b) => b.authors?.map((a) => a.name) ?? []))];
    return delay(names.filter((n) => n.toLowerCase().includes(q.toLowerCase())).map((name) => ({ id: `a-${name}`, name })));
  },
  async book(id) {
    const b = visible(who()).find((x) => x.id === id);
    if (!b) notFound();
    return delay({ ...b, ...summary(b, who()) });
  },
  coverUrl: (b) => b.coverPath,
  fileUrl: () => `${import.meta.env.BASE_URL}demo/sample.epub`,
  async getProgress(bookId) {
    return delay(store.get<ProgressRecord | null>(`bb-demo-progress-${who().id}-${bookId}`, null));
  },
  async putProgress(u: ProgressUpdate) {
    return delay({ bookId: u.bookId, status: "applied" as const, progress: saveProgress(u) });
  },
  async putProgressBatch(updates) {
    return delay({ results: updates.map((u) => ({ bookId: u.bookId, status: "applied" as const, progress: saveProgress(u) })) });
  },
  async bookmarks(bookId) {
    return delay(store.get<Bookmark[]>(`bb-demo-bookmarks-${who().id}`, []).filter((b) => b.bookId === bookId));
  },
  async addBookmark(nb: NewBookmark) {
    const all = store.get<Bookmark[]>(`bb-demo-bookmarks-${who().id}`, []);
    const b: Bookmark = { ...nb, id: nb.id ?? crypto.randomUUID(), createdAt: Date.now(), deletedAt: null };
    store.set(`bb-demo-bookmarks-${who().id}`, [...all, b]);
    return b;
  },
  async deleteBookmark(id) {
    const all = store.get<Bookmark[]>(`bb-demo-bookmarks-${who().id}`, []);
    store.set(`bb-demo-bookmarks-${who().id}`, all.filter((b) => b.id !== id));
  },
};
