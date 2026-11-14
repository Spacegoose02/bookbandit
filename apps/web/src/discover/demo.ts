/**
 * Demo-mode data for Discover, series and categories, built on the sample books in api/demo.ts
 * so kid mode filters the same way the server would.
 */
import { demoApi } from "../api/demo";
import type { BookSummary } from "../api/types";
import type { Category, DiscoverApi, DiscoverItem, SeriesBook, SeriesDetail } from "./api";

const wait = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));

async function visibleBooks(): Promise<BookSummary[]> {
  return (await demoApi.books(new URLSearchParams({ limit: "500" }))).items;
}

function notFound(): never {
  throw Object.assign(new Error("Not found"), { status: 404, notFound: true });
}

const COLORS = ["#3d5a80", "#ee6c4d", "#6a4c93", "#2b9348", "#c9184a", "#1982c4", "#8ac926", "#ff924c"];
function outsideCover(title: string, author: string, i: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const words = title.split(" ");
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + " " + w).length <= 11) lines[lines.length - 1] = last + " " + w;
    else lines.push(w);
  }
  const text = lines
    .slice(0, 4)
    .map((l, n) => `<text x="100" y="${110 + n * 32}" text-anchor="middle">${esc(l)}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="${COLORS[i % COLORS.length]}"/><circle cx="100" cy="52" r="22" fill="#fff" fill-opacity=".25"/><g font-family="Trebuchet MS,sans-serif" font-size="25" font-weight="700" fill="#fff">${text}</g><text x="100" y="270" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#fff" fill-opacity=".85">${esc(author)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const OUTSIDE: [string, string, number][] = [
  ["The Clockwork Orchard", "Imani Castell", 2026],
  ["Salt and Starlight", "Oren Vasquez", 2025],
  ["Hollow Hill", "Priya Navarro", 2026],
  ["The Cartographer's Daughter", "Wen Li", 2024],
  ["Midnight at the Lido", "Bea Thornton", 2025],
  ["A Field Guide to Small Joys", "Tomas Ek", 2026],
];

function item(b: BookSummary): DiscoverItem {
  return {
    key: `library:${b.id}`,
    title: b.title,
    authors: b.authors?.map((a) => a.name) ?? [],
    year: b.publishedYear,
    coverUrl: null,
    source: "library",
    url: `/book/${b.id}`,
    isbn13: null,
    status: b.kindleOnly ? "kindle" : "library",
    bookId: b.id,
    coverPath: b.coverPath,
    onKindle: b.kindleOnly,
  };
}

function outside(i: number): DiscoverItem {
  const [title, author, year] = OUTSIDE[i % OUTSIDE.length]!;
  return {
    key: `openlibrary:demo${i}`,
    title,
    authors: [author],
    year,
    coverUrl: outsideCover(title, author, i),
    source: "openlibrary",
    url: "https://openlibrary.org/trending/weekly",
    isbn13: null,
    status: "request",
    bookId: null,
    coverPath: null,
    onKindle: false,
  };
}

// Series edits made in the demo live for the page session.
const seriesEdits = new Map<string, { name?: string; description?: string | null; order?: string[] }>();
const createdSeries = new Map<string, { name: string; order: string[] }>();

async function allSeries(): Promise<SeriesDetail[]> {
  const books = await visibleBooks();
  const map = new Map<string, SeriesDetail>();
  for (const b of books)
    for (const s of b.series ?? []) {
      const entry = map.get(s.id) ?? { id: s.id, name: s.name, description: null, adminManaged: false, books: [] };
      entry.books.push({ ...b, position: s.position });
      map.set(s.id, entry);
    }
  for (const [id, c] of createdSeries)
    map.set(id, {
      id,
      name: c.name,
      description: null,
      adminManaged: true,
      books: c.order.flatMap((bid, i) => {
        const b = books.find((x) => x.id === bid);
        return b ? [{ ...b, position: i + 1 }] : [];
      }),
    });
  for (const s of map.values()) {
    s.books.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    const edit = seriesEdits.get(s.id);
    if (!edit) continue;
    if (edit.name) s.name = edit.name;
    if (edit.description !== undefined) s.description = edit.description;
    if (edit.order) {
      s.books = edit.order.flatMap((bid, i) => {
        const b = s.books.find((x) => x.id === bid);
        return b ? [{ ...b, position: i + 1 }] : [];
      });
    }
    s.adminManaged = true;
  }
  return [...map.values()].filter((s) => s.books.length);
}

const CATEGORY_RULES: [string, string, Category["kind"], RegExp][] = [
  ["cat-cook", "Cookbooks", "section", /soup|kitchen|bak/i],
  ["cat-picture", "Picture books", "section", /dino|barnaby/i],
  ["cat-adventure", "Adventure", "genre", /quest|storm|pebble|robot|road/i],
  ["cat-mystery", "Mystery", "genre", /secret|missing|lighthouse|manuscript/i],
  ["cat-literary", "Literary fiction", "genre", /garden|kyoto|lighthouse|winter/i],
];

async function categoryBooks(id: string): Promise<BookSummary[]> {
  const rule = CATEGORY_RULES.find((r) => r[0] === id);
  if (!rule) return [];
  return (await visibleBooks()).filter((b) => rule[3].test(b.title));
}

export const demoDiscoverApi: DiscoverApi = {
  async discover() {
    const books = await visibleBooks();
    const me = await demoApi.me();
    const family = books.filter((b) => b.percent != null || ["b1", "b4", "b9", "b12"].includes(b.id)).slice(0, 8);
    const pick = (ids: string[]) => ids.map((id) => books.find((b) => b.id === id)).filter((b): b is BookSummary => !!b);
    const lists = [
      {
        id: "openlibrary-weekly",
        name: "Trending this week",
        source: "openlibrary" as const,
        items: me.isKid
          ? pick(["b1", "b3", "b2"]).map(item)
          : [outside(0), ...pick(["b9"]).map(item), outside(1), ...pick(["b11"]).map(item), outside(2), ...pick(["b7"]).map(item), outside(3)],
      },
      {
        id: "openlibrary-yearly",
        name: "Popular this year",
        source: "openlibrary" as const,
        items: me.isKid ? [] : [outside(4), ...pick(["b13", "b4"]).map(item), outside(5)],
      },
      { id: "family", name: "Popular in your family", source: "library" as const, items: family.map(item) },
    ].filter((l) => l.items.length);
    return wait({ lists, online: true, requests: !me.isKid });
  },
  async seriesList(q) {
    const all = await allSeries();
    const items = all
      .filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()))
      .map((s) => ({ ...s, bookCount: s.books.length, books: s.books.slice(0, 4) }));
    return wait({ items, total: items.length });
  },
  async series(id) {
    const s = (await allSeries()).find((x) => x.id === id);
    if (!s) notFound();
    return wait(s);
  },
  async createSeries(name, bookIds) {
    const id = `series:new-${createdSeries.size + 1}`;
    createdSeries.set(id, { name, order: bookIds });
    return wait({ id });
  },
  async updateSeries(id, patch) {
    seriesEdits.set(id, { ...seriesEdits.get(id), ...patch });
    const created = createdSeries.get(id);
    if (created && patch.name) created.name = patch.name;
  },
  async setSeriesBooks(id, books) {
    const order = books.map((b) => b.bookId);
    const created = createdSeries.get(id);
    if (created) created.order = order;
    else seriesEdits.set(id, { ...seriesEdits.get(id), order });
    const s = (await allSeries()).find((x) => x.id === id);
    return wait((s?.books ?? []) as SeriesBook[]);
  },
  async deleteSeries(id) {
    createdSeries.delete(id);
    seriesEdits.delete(id);
  },
  async categories() {
    const out: Category[] = [];
    for (const [id, name, kind] of CATEGORY_RULES) {
      const books = await categoryBooks(id);
      if (books.length) out.push({ id, name, kind, bookCount: books.length, cookbook: id === "cat-cook", books: books.slice(0, 3) });
    }
    return wait(out);
  },
  async category(id) {
    const rule = CATEGORY_RULES.find((r) => r[0] === id);
    const items = await categoryBooks(id);
    if (!rule || !items.length) notFound();
    return wait({ category: { id, name: rule[1], kind: rule[2], cookbook: id === "cat-cook" }, items, total: items.length });
  },
  async bookCategories(bookId) {
    const books = await visibleBooks();
    const b = books.find((x) => x.id === bookId);
    if (!b) notFound();
    const items = CATEGORY_RULES.filter((r) => r[3].test(b.title)).map(([id, name, kind]) => ({
      id,
      name,
      kind,
      cookbook: id === "cat-cook",
    }));
    return wait({ items, cookbook: items.some((i) => i.cookbook) });
  },
  async kindleImport(csv, opts) {
    const rows = csv.split(/\r?\n/).slice(1).filter((l) => l.trim()).length;
    return wait({ rows, created: Math.max(0, rows - 1), linked: rows ? 1 : 0, skipped: 0, errors: [], dryRun: !!opts.dryRun });
  },
  async requestBook() {
    return wait({ status: "sent" as const });
  },
};
