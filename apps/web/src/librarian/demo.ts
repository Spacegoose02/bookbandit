/**
 * Sample data for the librarian pages in demo mode (`?demo`), for development and screenshots.
 * Kept in memory; a reload starts over.
 */
import type { CopyGroup, Health, LibBook, LibJob, LibrarianApi, WorkGroup } from "./api";

const now = Date.UTC(2026, 10, 14, 2, 0);
const H = 3_600_000;
const D = 24 * H;
const delay = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

const COLORS = ["#264653", "#e76f51", "#2a9d8f", "#8338ec", "#3a86ff", "#ff006e", "#8d6e63", "#6a994e", "#bc4749"];
export function demoCover(title: string, i: number, style: "plain" | "photo" = "plain"): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const words = title.split(" ");
  const c = COLORS[i % COLORS.length];
  const art =
    style === "photo"
      ? `<circle cx="150" cy="70" r="40" fill="#fff3" /><path d="M0 230 L60 170 L110 210 L160 150 L200 190 L200 300 L0 300Z" fill="#0004"/>`
      : `<rect x="16" y="16" width="168" height="268" fill="none" stroke="#fff6" stroke-width="2"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="${c}"/>${art}<text x="100" y="130" text-anchor="middle" font-family="Georgia,serif" font-size="22" font-weight="700" fill="#fff">${esc(words.slice(0, 2).join(" "))}</text><text x="100" y="160" text-anchor="middle" font-family="Georgia,serif" font-size="22" font-weight="700" fill="#fff">${esc(words.slice(2, 4).join(" "))}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

let n = 0;
const file = (relPath: string, sizeBytes: number, sha = `h${++n}`) => ({ id: `f-${relPath}`, relPath, format: relPath.endsWith(".kepub.epub") ? "kepub" : relPath.split(".").pop()!, sizeBytes, sha256: sha });

function book(id: string, title: string, authors: string[], o: Partial<LibBook> & { cover?: boolean } = {}): LibBook {
  const { cover = true, ...rest } = o;
  return {
    id,
    title,
    subtitle: null,
    authors,
    series: null,
    tags: [],
    language: "en",
    publishedYear: 2020,
    isbn13: null,
    publisher: null,
    description: null,
    coverPath: cover ? demoCover(title, id.length + title.length) : null,
    rating: "middle_grade",
    ratingSource: "admin",
    approved: true,
    kindleOnly: false,
    files: [file(`${authors[0] ?? "Unknown"}/${title}.epub`, 1_800_000)],
    addedAt: now - 30 * D,
    updatedAt: null,
    ...rest,
  };
}

const pebble = (i: number) =>
  book(`pb${i}`, ["Storm Over Pebble Bay", "The Lighthouse Key", "Fog at Gull Point", "The Smugglers' Cove", "Winter Tides", "The Last Ferry", "Shipwreck Summer", "Harbor Lights", "The Pebble Bay Fair", "Home to Pebble Bay"][i - 1]!, ["Ada Brightwater"], {
    series: i <= 3 ? { id: "s-pb", name: "Pebble Bay", position: i } : null,
    rating: "middle_grade",
    publishedYear: 2016 + i,
    addedAt: now - (40 - i) * D,
    tags: [{ name: "Adventure", kind: "genre" }],
  });

let library: LibBook[] = [
  ...Array.from({ length: 10 }, (_, i) => pebble(i + 1)),
  book("b-owl", "The Owl Who Counted Stars", ["Juniper Vale"], { rating: "kids", series: { id: "s-owl", name: "Night Owls", position: 1 }, tags: [{ name: "Bedtime", kind: "section" }] }),
  book("b-pixel", "Pixel Quest", ["Max Byte"], { rating: "kids", files: [file("Max Byte/Pixel Quest.epub", 2_100_000, "pq"), file("Max Byte/Pixel Quest.pdf", 9_800_000)] }),
  book("b-pixel2", "Pixel Quest", ["Max Byte"], { rating: "kids", approved: false, ratingSource: "folder", files: [file("_incoming/pixel-quest (1).epub", 2_150_000)], addedAt: now - 2 * D }),
  book("b-night", "Night Train to Lisbon", ["Lena Cole"], { rating: "adult", files: [file("Lena Cole/Night Train to Lisbon.mobi", 1_100_000)], cover: false }),
  book("b-garden", "The Secret Garden Club", ["Mira Okafor"], { rating: null, ratingSource: null, files: [file("Mira Okafor/The Secret Garden Club.azw3", 900_000)] }),
  book("b-moon", "Moonlight Recipes", [], { rating: "adult", cover: false, tags: [{ name: "Cookbook", kind: "section" }] }),
  book("b-moon2", "Moonlight Recipes", ["Sam Ruiz"], { rating: "adult", isbn13: "9780000000033", files: [file("Cookbooks/Moonlight Recipes.pdf", 14_000_000)] }),
  book("b-dragon", "Dragon School Diaries", ["Pip Hollow"], { rating: "kids", isbn13: "9780000000071", series: { id: "s-ds", name: "Dragon School", position: 1 } }),
  book("b-dragon2", "Dragon School Diaries: Book One", ["P. Hollow"], { rating: "kids", isbn13: "9780000000071", files: [file("Kids/dragon-school-1.fb2", 400_000)], cover: false }),
  book("b-river", "River of Stars", ["Theo Lark"], { rating: "teen", files: [file("Teen/Theo Lark/River of Stars.epub", 3_000_000, "rs"), file("Backups/River of Stars.epub", 3_000_000, "rs")] }),
  book("b-quiet", "The Quiet Year", [], { rating: null, ratingSource: null, cover: false, files: [] }),
];

const readers: Record<string, { readers: number; bookmarks: number }> = { "b-pixel": { readers: 2, bookmarks: 5 }, "b-moon2": { readers: 1, bookmarks: 0 }, "b-dragon": { readers: 1, bookmarks: 2 } };
let ignoredKeys: string[] = [];
let writeMetadata = false;
let jobs: LibJob[] = [
  { id: "j1", type: "librarian.convert", label: "Convert Storm Over Pebble Bay (MOBI → EPUB)", status: "done", progress: 1, lastError: null, createdAt: now - 3 * H, finishedAt: now - 3 * H + 40_000 },
  { id: "j2", type: "librarian.kepub", label: "Prepare every EPUB for Kobo", status: "done", progress: 1, lastError: null, createdAt: now - 2 * D, finishedAt: now - 2 * D + 600_000 },
  { id: "j3", type: "librarian.convert", label: "Convert Locked Kindle Book (AZW3 → EPUB)", status: "failed", progress: 0.1, lastError: "This file is DRM-protected; Bookbandit never converts DRM files", createdAt: now - 3 * D, finishedAt: now - 3 * D + 2000 },
];

const notFound = (): never => {
  throw Object.assign(new Error("Not found"), { status: 404 });
};
const byId = (id: string) => library.find((b) => b.id === id) ?? notFound();

const GROUPS: { reason: WorkGroup["reason"]; ids: string[] }[] = [
  { reason: "title_author", ids: ["b-pixel", "b-pixel2"] },
  { reason: "isbn", ids: ["b-dragon", "b-dragon2"] },
  { reason: "title", ids: ["b-moon2", "b-moon"] },
];

function duplicates() {
  const sameWork: WorkGroup[] = GROUPS.map((g) => ({ ...g, key: [...g.ids].sort().join(",") }))
    .filter((g) => !ignoredKeys.includes(g.key) && g.ids.every((id) => library.some((b) => b.id === id)))
    .map((g) => ({ key: g.key, reason: g.reason, books: g.ids.map((id) => ({ ...byId(id), ...(readers[id] ?? { readers: 0, bookmarks: 0 }) })) }));
  const byHash = new Map<string, CopyGroup>();
  for (const b of library)
    for (const f of b.files) {
      if (!f.sha256) continue;
      const g = byHash.get(f.sha256) ?? { sha256: f.sha256, sizeBytes: f.sizeBytes, files: [] };
      g.files.push({ id: f.id, relPath: f.relPath, format: f.format, bookId: b.id, bookTitle: b.title });
      byHash.set(f.sha256, g);
    }
  return { sameWork, copies: [...byHash.values()].filter((g) => g.files.length > 1), ignored: ignoredKeys.length };
}

function checkOf(b: LibBook) {
  return {
    no_cover: !b.coverPath,
    no_rating: !b.rating && !b.kindleOnly,
    no_author: !b.authors.length,
    no_files: !b.files.length && !b.kindleOnly,
  };
}

let fileReport: Health["files"] = {
  checkedAt: now - 5 * H,
  filesChecked: 31,
  problems: [
    { fileId: "f-x1", bookId: "b-garden", title: "The Secret Garden Club", relPath: "Mira Okafor/The Secret Garden Club.azw3", format: "azw3", problem: "drm" },
    { fileId: "f-x2", bookId: "b-river", title: "River of Stars", relPath: "Backups/River of Stars (copy).epub", format: "epub", problem: "unreadable", detail: "The zip archive is damaged" },
    { fileId: "f-x3", bookId: "b-quiet", title: "The Quiet Year", relPath: "Adult/The Quiet Year.epub", format: "epub", problem: "missing" },
  ],
};

export const demoLibrarianApi: LibrarianApi = {
  async books(q) {
    let items = library;
    if (q.q) {
      const s = q.q.toLowerCase();
      items = items.filter((b) => b.title.toLowerCase().includes(s) || b.authors.some((a) => a.toLowerCase().includes(s)) || b.series?.name.toLowerCase().includes(s));
    }
    if (q.check) items = items.filter((b) => checkOf(b)[q.check!]);
    if (q.format) items = items.filter((b) => b.files.some((f) => f.format === q.format));
    items = [...items].sort((a, b) => (q.sort === "added" ? b.addedAt - a.addedAt : a.title.localeCompare(b.title)));
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 100;
    return delay({ items: items.slice(offset, offset + limit), total: items.length, limit, offset });
  },
  series: () =>
    delay(
      [...new Map(library.filter((b) => b.series).map((b) => [b.series!.id, b.series!.name])).entries()].map(([id, name]) => ({
        id,
        name,
        books: library.filter((b) => b.series?.id === id).length,
      })),
    ),
  async bulk(c) {
    const sid = c.series ? (library.find((b) => b.series?.name.toLowerCase() === c.series!.name.toLowerCase())?.series?.id ?? `s-${Date.now()}`) : null;
    c.ids.forEach((id, i) => {
      const b = byId(id);
      if (c.rating !== undefined) Object.assign(b, { rating: c.rating, ratingSource: c.rating ? "admin" : null });
      if (c.language !== undefined) b.language = c.language;
      if (c.authors) b.authors = c.authors;
      if (c.series === null) b.series = null;
      else if (c.series) {
        const position = c.series.numbering === "sequence" ? (c.series.start ?? 1) + i : c.series.numbering === "clear" ? null : (b.series?.position ?? null);
        b.series = { id: sid!, name: c.series.name, position };
      }
      for (const t of c.tagsAdd ?? []) if (!b.tags.some((x) => x.name.toLowerCase() === t.toLowerCase())) b.tags = [...b.tags, { name: t, kind: "custom" }];
      if (c.tagsRemove) b.tags = b.tags.filter((x) => !c.tagsRemove!.some((t) => t.toLowerCase() === x.name.toLowerCase()));
      b.updatedAt = Date.now();
    });
    return delay({ updated: c.ids.length, writeMetadataJobs: 0, items: c.ids.map(byId) });
  },
  duplicates: () => delay(duplicates()),
  async mergeDuplicates(keepId, otherIds) {
    const keep = byId(keepId);
    for (const id of otherIds) keep.files = [...keep.files, ...byId(id).files];
    library = library.filter((b) => !otherIds.includes(b.id));
    await delay(null);
  },
  async keepDuplicate(_keepId, otherIds) {
    const setAside = otherIds.flatMap((id) => byId(id).files.map((f) => `.duplicates/${f.relPath}`));
    library = library.filter((b) => !otherIds.includes(b.id));
    return delay({ setAside });
  },
  async removeCopies(fileIds) {
    const setAside: string[] = [];
    for (const b of library) {
      setAside.push(...b.files.filter((f) => fileIds.includes(f.id)).map((f) => `.duplicates/${f.relPath}`));
      b.files = b.files.filter((f) => !fileIds.includes(f.id));
    }
    return delay({ setAside });
  },
  async ignoreDuplicates(bookIds) {
    ignoredKeys = [...ignoredKeys, [...bookIds].sort().join(",")];
    await delay(null);
  },
  async clearIgnored() {
    ignoredKeys = [];
    await delay(null);
  },
  tools: () =>
    delay({
      ebookConvert: true,
      kepubify: true,
      needsConversion: library.filter((b) => b.files.some((f) => ["mobi", "azw3", "fb2", "txt"].includes(f.format)) && !b.files.some((f) => f.format === "epub")).length,
      epubBooks: library.filter((b) => b.files.some((f) => f.format === "epub")).length,
      settings: { writeMetadata },
      jobs,
    }),
  convertible: () => delay(library.filter((b) => b.files.some((f) => ["mobi", "azw3", "fb2", "txt"].includes(f.format)) && !b.files.some((f) => f.format === "epub"))),
  async convert(bookIds) {
    const queued = bookIds.map((bookId) => {
      const b = byId(bookId);
      const src = b.files.find((f) => ["azw3", "mobi", "fb2", "txt"].includes(f.format))!;
      const id = `j-${Date.now()}-${bookId}`;
      jobs = [{ id, type: "librarian.convert", label: `Convert ${b.title} (${src.format.toUpperCase()} → EPUB)`, status: "running", progress: 0.4, lastError: null, createdAt: Date.now(), finishedAt: null }, ...jobs];
      setTimeout(() => {
        b.files = [...b.files, file(src.relPath.replace(/\.\w+$/, ".epub"), Math.round(src.sizeBytes * 1.3))];
        jobs = jobs.map((j) => (j.id === id ? { ...j, status: "done", progress: 1, finishedAt: Date.now() } : j));
      }, 1500);
      return { bookId, jobId: id };
    });
    return delay({ queued, skipped: [] });
  },
  async prepareKobo() {
    const id = `j-kepub-${Date.now()}`;
    jobs = [{ id, type: "librarian.kepub", label: "Prepare every EPUB for Kobo", status: "running", progress: 0.2, lastError: null, createdAt: Date.now(), finishedAt: null }, ...jobs];
    return delay({ jobId: id });
  },
  async setWriteMetadata(on) {
    writeMetadata = on;
    return delay({ writeMetadata });
  },
  writeMetadata: (ids) => delay({ queued: ids.length }),
  covers: (bookId) => {
    const b = byId(bookId);
    return delay(
      {
        current: b.coverPath,
        candidates: [
          ...(b.files.some((f) => f.format === "epub") ? [{ source: "file" as const, label: `From ${b.files[0]!.relPath.split("/").pop()}`, url: demoCover(b.title, 1), fileId: b.files[0]!.id }] : []),
          { source: "hardcover" as const, label: "Hardcover", url: demoCover(b.title, 3, "photo") },
          { source: "google" as const, label: "Google Books", url: demoCover(b.title, 4) },
          { source: "openlibrary" as const, label: "Open Library", url: demoCover(b.title, 5, "photo") },
        ],
        errors: [],
      },
      300,
    );
  },
  async setCover(bookId, choice) {
    const b = byId(bookId);
    b.coverPath = "url" in choice ? choice.url : "image" in choice ? choice.image : demoCover(b.title, 1);
    b.updatedAt = Date.now();
    return delay(b);
  },
  health: () => {
    const counts = { no_cover: 0, no_rating: 0, no_author: 0, no_files: 0 };
    for (const b of library) for (const [k, v] of Object.entries(checkOf(b))) if (v) counts[k as keyof typeof counts]++;
    return delay({ counts, files: fileReport, running: null });
  },
  async checkFiles() {
    fileReport = fileReport ? { ...fileReport, checkedAt: Date.now() } : null;
    return delay({ jobId: "j-health" });
  },
  coverUrl: (b) => b.coverPath,
};

