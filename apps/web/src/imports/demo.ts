/**
 * Demo-mode imports (`?demo=admin`): believable reports without a server, for development and
 * screenshots. Kept in memory; a reload starts over.
 */
import type { HouseholdPerson, ImportJob, ImportReport, ImportRequest, ImportsApi, PastImport, ReportItem } from "./api";
import { newId } from "../app/uuid";

const delay = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const now = Date.UTC(2026, 10, 14, 4, 0);

const people: HouseholdPerson[] = [
  { id: "u-adult", displayName: "Sam", role: "admin" },
  { id: "u-alex", displayName: "Alex", role: "parent" },
  { id: "u-gran", displayName: "Grandma Rose", role: "adult" },
  { id: "u-kid", displayName: "Mia", role: "kid" },
  { id: "u-kid2", displayName: "Theo", role: "kid" },
];

const items = (list: [ReportItem["status"], string, string?][]): ReportItem[] =>
  list.map(([status, title, detail]) => ({ status, title, ...(detail ? { detail } : {}) }));

function reportFor(body: ImportRequest): ImportReport {
  const base = { dryRun: body.dryRun, warnings: [] as string[] };
  switch (body.source) {
    case "calibre":
      return {
        ...base,
        source: "calibre",
        counts: { matched: 1184, new: 0, skipped: 23, conflict: 41 },
        stats: { "books in Calibre": 1248, "series linked": 312, "tags added": 2210, covers: 1225 },
        items: items([
          ["conflict", "Mistborn: The Final Empire — Brandon Sanderson", "Calibre's value wins for title, series number"],
          ["conflict", "The Hobbit — J. R. R. Tolkien", "Calibre's value wins for authors"],
          ["matched", "Project Hail Mary — Andy Weir"],
          ["matched", "Pixel Quest — Ada Byte"],
          ["matched", "The Wild Robot — Peter Brown"],
          ["matched", "Dog Man — Dav Pilkey", "matched by file hash"],
          ["skipped", "Cooking for Crowds — Ina Garten", "No file for it in Bookbandit yet (MOBI). Scan the library, or check the Calibre folder is inside /books."],
          ["skipped", "Old Tax Notes", "Calibre has no file for this book."],
        ]),
      };
    case "calibre-web": {
      const map = (id: string, guess: string | null) => (id in body.people ? body.people[id]! : guess);
      return {
        ...base,
        source: "calibre-web",
        counts: { matched: 96, new: 58, skipped: 7, conflict: 2 },
        stats: { "collections created": 6, "books put in collections": 143 },
        items: items([
          ["new", "sam: Project Hail Mary", "Finished"],
          ["new", "mia: The Wild Robot", "Reading, 40%"],
          ["matched", "theo: Pixel Quest", "Kobo position 72%"],
          ["conflict", "sam: Mistborn: The Final Empire", "Bookbandit has a newer position; kept it."],
          ["new", 'Shelf "Bedtime" (mia)', "18 books added"],
          ["new", 'Shelf "Family favourites" (sam, shared)', "42 books added"],
          ["skipped", "Calibre-Web user guest-tablet", "Not matched to anyone in Bookbandit."],
        ]),
        people: [
          { id: "1", name: "sam", email: "sam@example.com", userId: map("1", "u-adult"), guessed: !("1" in body.people) },
          { id: "3", name: "mia", email: null, userId: map("3", "u-kid"), guessed: !("3" in body.people) },
          { id: "4", name: "theo", email: null, userId: map("4", "u-kid2"), guessed: !("4" in body.people) },
          { id: "5", name: "guest-tablet", email: null, userId: map("5", null), guessed: false },
        ],
      };
    }
    case "kavita":
      return {
        ...base,
        source: "kavita",
        counts: { matched: 37, new: 3, skipped: 4, conflict: 1 },
        stats: { "collections created": 3, "books put in collections": 22 },
        items: items([
          ["matched", "theo: Dog Man 01", "Finished"],
          ["matched", "theo: Bone 03", "62%"],
          ["new", 'Collection "Comics night" (theo)', "12 books added"],
          ["conflict", "sam: Saga Vol. 1", "Bookbandit has a newer position; kept it."],
          ["skipped", "theo: Manga Sampler (#410)", "No matching file in Bookbandit (/manga/Sampler/sampler.cbz)"],
        ]),
        people: body.accounts.map((a, i) => ({ id: String(i), name: ["sam-kavita", "theo"][i] ?? `user${i + 1}`, userId: a.userId, guessed: false })),
      };
    case "goodreads":
      return {
        ...base,
        source: "goodreads",
        counts: { matched: 64, new: 412, skipped: 0, conflict: 1 },
        stats: { "in the library": 64, "collections created": 1 },
        items: items([
          ["matched", "Mistborn: The Final Empire (Mistborn, #1) — Brandon Sanderson", "read, 5★; in the library; marked finished"],
          ["matched", "The Hobbit — J.R.R. Tolkien", 'to-read; in the library; on "Want to read"'],
          ["new", "Educated — Tara Westover", "read, 4★; history only (not in the library)"],
          ["new", "The Midnight Library — Matt Haig", "read, 3★; history only (not in the library)"],
          ["conflict", "Project Hail Mary — Andy Weir", "Bookbandit has newer progress; kept it"],
        ]),
      };
    case "google-play":
      return {
        ...base,
        source: "google-play",
        counts: { matched: 9, new: 31, skipped: 2, conflict: 0 },
        stats: {},
        items: items([
          ["new", "The Martian — Andy Weir", "On Google Play Books"],
          ["new", "Atomic Habits — James Clear", "On Google Play Books"],
          ["matched", "Dune — Frank Herbert", "Already in the library; added the Google Play link"],
          ["skipped", "The Hobbit — J. R. R. Tolkien", "Already imported"],
        ]),
      };
  }
}

const jobs = new Map<string, ImportJob & { polls: number }>();
const past: PastImport[] = [
  {
    id: "past-1",
    source: "calibre",
    dryRun: false,
    label: "Import: Calibre library",
    status: "done",
    progress: 1,
    error: null,
    createdAt: now - 26 * 3_600_000,
    finishedAt: now - 26 * 3_600_000 + 95_000,
    report: { source: "calibre", dryRun: false, counts: { matched: 1184, new: 0, skipped: 23, conflict: 41 }, stats: {}, warnings: 0 },
  },
];

export const demoImportsApi: ImportsApi = {
  people: () => delay({ items: people }),
  upload: (file) => delay({ uploadId: newId(), name: file.name, size: file.size }, 300),
  async start(body) {
    const id = newId();
    const label = `${body.dryRun ? "Dry run" : "Import"}: ${body.source}`;
    jobs.set(id, { id, source: body.source, dryRun: body.dryRun, label, status: "running", progress: 0.1, error: null, createdAt: Date.now(), finishedAt: null, report: reportFor(body), polls: 0 });
    return delay({ jobId: id });
  },
  async job(id) {
    const j = jobs.get(id);
    if (!j) throw new Error("Not found");
    j.polls++;
    const done = j.polls >= 2;
    const { polls: _p, ...view } = j;
    const out: ImportJob = done ? { ...view, status: "done", progress: 1, finishedAt: Date.now() } : { ...view, progress: 0.5, report: null };
    if (done && !past.some((p) => p.id === id)) {
      past.unshift({ ...out, report: out.report ? { source: out.report.source, dryRun: out.report.dryRun, counts: out.report.counts, stats: out.report.stats, warnings: out.report.warnings.length } : null });
    }
    return delay(out);
  },
  list: () => delay({ items: past }),
  exportUrl: () => "data:text/csv;charset=utf-8,Book%20Id%2CTitle%0A",
  elsewhere: () => delay({ googlePlay: null }),
};
