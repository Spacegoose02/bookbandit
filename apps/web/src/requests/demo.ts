/**
 * Sample requests, downloads and settings for demo mode (`?demo`, `?demo=kid`, `?demo=admin`).
 * Kept in memory for the page's lifetime; nothing is sent anywhere.
 */
import { canSee, type ContentRating } from "@bookbandit/shared";
import { ApiError } from "../api/client";
import type { RequestsApi } from "./api";
import type { BookRequest, Candidate, DownloadSettings, Job, JobDetail, RequestStatus } from "./types";

type Who = "kid" | "adult" | "admin";

function who(): Who {
  try {
    const v = sessionStorage.getItem("bb-demo-user");
    return v === "kid" || v === "admin" ? v : "adult";
  } catch {
    return "adult";
  }
}

const KID_ACCESS = { isKid: true, birthYear: new Date().getUTCFullYear() - 7, explicitOptIn: false };
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 14, 9, 0);
const COLORS = ["#2a9d8f", "#e76f51", "#8338ec", "#3a86ff", "#ff006e", "#06d6a0", "#e9c46a", "#264653"];

function cover(title: string, i: number): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const words = title.split(" ");
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && `${last} ${w}`.length <= 11) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  const text = lines
    .slice(0, 4)
    .map((l, n) => `<text x="100" y="${90 + n * 30}" font-size="22" font-family="Georgia,serif" font-weight="700" fill="#fff" text-anchor="middle">${esc(l)}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><rect width="200" height="300" fill="${COLORS[i % COLORS.length]}"/><rect x="12" y="12" width="176" height="276" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="2"/>${text}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const CATALOG: Omit<Candidate, "coverUrl" | "ref" | "inLibrary">[] = [
  { title: "The Wild Robot", author: "Peter Brown", publishedYear: 2016, isbn13: "9780316381994", rating: "middle_grade", ratingReason: 'genre "Juvenile Fiction"' },
  { title: "The Wild Robot Escapes", author: "Peter Brown", publishedYear: 2018, isbn13: "9780316479295", rating: "middle_grade", ratingReason: 'genre "Juvenile Fiction"' },
  { title: "The Wild Robot Protects", author: "Peter Brown", publishedYear: 2023, isbn13: "9780316669412", rating: "middle_grade", ratingReason: 'genre "Juvenile Fiction"' },
  { title: "Dragons Love Tacos", author: "Adam Rubin", publishedYear: 2012, isbn13: "9780803736801", rating: "kids", ratingReason: 'genre "Picture books"' },
  { title: "Dinosaur Dance!", author: "Sandra Boynton", publishedYear: 2016, isbn13: "9781481480383", rating: "kids", ratingReason: 'genre "Board books"' },
  { title: "How to Catch a Dinosaur", author: "Adam Wallace", publishedYear: 2019, isbn13: "9781492669050", rating: "kids", ratingReason: 'genre "Picture books"' },
  { title: "Project Hail Mary", author: "Andy Weir", publishedYear: 2021, isbn13: "9780593135204", rating: null, ratingReason: null },
  { title: "The Hunger Games", author: "Suzanne Collins", publishedYear: 2008, isbn13: "9780439023481", rating: "teen", ratingReason: 'genre "Young Adult Fiction"' },
  { title: "Wild Robot Dreams", author: "Unknown", publishedYear: 2020, isbn13: null, rating: null, ratingReason: null },
];

const candidates: Candidate[] = CATALOG.map((c, i) => ({ ...c, ref: `openlibrary:OL${i}W`, coverUrl: cover(c.title, i), inLibrary: null }));

let seq = 10;
const req = (
  over: Partial<BookRequest> & Pick<BookRequest, "title" | "status">,
  by: "Mia" | "Sam" | "Leo" | "Aunt Jo",
  i: number,
): BookRequest => ({
  id: `r${++seq}`,
  author: null,
  isbn13: null,
  coverUrl: cover(over.title, i),
  publishedYear: null,
  rating: null,
  ratingReason: null,
  note: null,
  requestedBy: {
    id: by === "Mia" ? "u-kid" : by === "Sam" ? "u-adult" : `u-${by.toLowerCase()}`,
    displayName: by,
    role: by === "Mia" || by === "Leo" ? "kid" : by === "Sam" ? "parent" : "adult",
    avatar: by === "Mia" ? "🦖" : by === "Leo" ? "🚀" : null,
  },
  decidedBy: null,
  createdAt: NOW - i * 5 * HOUR,
  updatedAt: null,
  decidedAt: null,
  book: null,
  waitingForReview: false,
  download: null,
  canApprove: false,
  canDecline: false,
  canCancel: false,
  canDownload: false,
  ...over,
});

let requests: BookRequest[] = [
  req({ title: "Dragons Love Tacos", author: "Adam Rubin", rating: "kids", ratingReason: 'genre "Picture books"', status: "pending", note: "Please!! 🌮" }, "Mia", 3),
  req({ title: "The Wild Robot", author: "Peter Brown", rating: "middle_grade", ratingReason: 'genre "Juvenile Fiction"', status: "pending" }, "Leo", 0),
  req(
    { title: "Dinosaur Dance!", author: "Sandra Boynton", rating: "kids", status: "downloading", decidedBy: { id: "u-adult", displayName: "Sam" }, download: { jobId: "j1", status: "running", progress: 0.55, error: null } },
    "Mia",
    4,
  ),
  req({ title: "How to Catch a Dinosaur", author: "Adam Wallace", rating: "kids", status: "done", decidedBy: { id: "u-adult", displayName: "Sam" }, book: { id: "b1", title: "How to Catch a Dinosaur", coverPath: null } }, "Mia", 5),
  req({ title: "The Hunger Games", author: "Suzanne Collins", rating: "teen", status: "declined", note: "This book is rated Teen (13+), above Kids (up to 7)." }, "Mia", 7),
  req({ title: "Project Hail Mary", author: "Andy Weir", status: "failed", note: "Not found by shelfmark or sabnzbd" }, "Aunt Jo", 6),
  req({ title: "Piranesi", author: "Susanna Clarke", status: "pending", note: "For book club in December" }, "Aunt Jo", 2),
];

function meId(): string {
  return who() === "kid" ? "u-kid" : "u-adult";
}

/** Fill in the per-viewer flags the server would compute. */
function view(r: BookRequest): BookRequest {
  const w = who();
  const mine = r.requestedBy?.id === meId();
  const approver = w === "admin" || (w === "adult" && r.requestedBy?.role === "kid");
  return {
    ...r,
    canApprove: approver && !mine && (r.status === "pending" || r.status === "declined"),
    canDecline: approver && !mine && (r.status === "pending" || r.status === "approved"),
    canCancel: mine && r.status === "pending",
    canDownload: w === "admin" && (r.status === "approved" || r.status === "failed"),
    download: r.download && w !== "admin" ? { ...r.download, jobId: null, error: null } : r.download,
  };
}

const delay = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));

const jobs: JobDetail[] = [
  {
    id: "j1",
    type: "downloads.fetch",
    label: "Request: Dinosaur Dance!",
    status: "running",
    attempts: 1,
    maxAttempts: 4,
    progress: 0.55,
    lastError: null,
    result: null,
    runAfter: NOW - HOUR,
    createdAt: NOW - HOUR,
    startedAt: NOW - HOUR,
    finishedAt: null,
    updatedAt: NOW - 60_000,
    payload: {},
    logs: [
      { at: NOW - HOUR, level: "info", message: 'Shelfmark: searching for "Dinosaur Dance! Sandra Boynton"' },
      { at: NOW - HOUR + 2000, level: "info", message: 'Shelfmark: found "Dinosaur Dance!" by Sandra Boynton (hardcover)' },
      { at: NOW - HOUR + 4000, level: "info", message: "Shelfmark: queueing epub from direct_download (2.1 MB)" },
    ],
  },
  {
    id: "j2",
    type: "downloads.fetch",
    label: "Request: How to Catch a Dinosaur",
    status: "done",
    attempts: 1,
    maxAttempts: 4,
    progress: 1,
    lastError: null,
    result: { via: "shelfmark", files: ["_incoming/requests/r15/How to Catch a Dinosaur.epub"], bookIds: ["b1"] },
    runAfter: NOW - 9 * HOUR,
    createdAt: NOW - 9 * HOUR,
    startedAt: NOW - 9 * HOUR,
    finishedAt: NOW - 8.9 * HOUR,
    updatedAt: NOW - 8.9 * HOUR,
    payload: {},
    logs: [
      { at: NOW - 9 * HOUR, level: "info", message: 'Shelfmark: searching for "How to Catch a Dinosaur Adam Wallace"' },
      { at: NOW - 8.95 * HOUR, level: "info", message: "Shelfmark: download complete" },
      { at: NOW - 8.95 * HOUR, level: "info", message: "Saved _incoming/requests/r15/How to Catch a Dinosaur.epub (812 KB)" },
      { at: NOW - 8.9 * HOUR, level: "info", message: "Scanning the library" },
      { at: NOW - 8.9 * HOUR, level: "info", message: "In the inbox: 1 book" },
    ],
  },
  {
    id: "j3",
    type: "downloads.fetch",
    label: "Request: Project Hail Mary",
    status: "failed",
    attempts: 1,
    maxAttempts: 4,
    progress: null,
    lastError: "Not found by shelfmark or sabnzbd",
    result: null,
    runAfter: NOW - 30 * HOUR,
    createdAt: NOW - 30 * HOUR,
    startedAt: NOW - 30 * HOUR,
    finishedAt: NOW - 30 * HOUR,
    updatedAt: NOW - 30 * HOUR,
    payload: {},
    logs: [
      { at: NOW - 30 * HOUR, level: "warn", message: "shelfmark: Shelfmark found no matching book" },
      { at: NOW - 30 * HOUR, level: "warn", message: "sabnzbd: The indexer found no matching NZB (0 results)" },
      { at: NOW - 30 * HOUR, level: "error", message: "Not found by shelfmark or sabnzbd" },
    ],
  },
  {
    id: "j4",
    type: "library.scan",
    label: "Scan after upload: Piranesi.epub",
    status: "done",
    attempts: 1,
    maxAttempts: 5,
    progress: 1,
    lastError: null,
    result: { added: 1, removed: 0, errors: 0 },
    runAfter: NOW - 3 * HOUR,
    createdAt: NOW - 3 * HOUR,
    startedAt: NOW - 3 * HOUR,
    finishedAt: NOW - 3 * HOUR,
    updatedAt: NOW - 3 * HOUR,
    payload: {},
    logs: [],
  },
];

let settings: DownloadSettings = {
  autoDownload: true,
  order: ["shelfmark", "sabnzbd"],
  shelfmark: { enabled: true, url: "http://shelfmark:8084", hasApiKey: true },
  sabnzbd: { enabled: true, url: "http://sabnzbd:8080", hasApiKey: true, category: "books", pathMap: { from: "/downloads/complete", to: "/sab-complete" } },
  newznab: null,
  direct: { enabled: true, maxMb: 500 },
  uploads: { allowAdults: false, maxMb: 500 },
  available: ["shelfmark"],
};

function strip({ payload: _p, logs: _l, ...j }: JobDetail): Job {
  return j;
}

function adminOnly() {
  if (who() !== "admin") throw new ApiError(403, "Admins only");
}

export const demoRequestsApi: RequestsApi = {
  async search(q) {
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    let items = candidates.filter((c) => words.some((w) => `${c.title} ${c.author}`.toLowerCase().includes(w)));
    const all = items.length;
    if (who() === "kid") items = items.filter((c) => c.rating && canSee(KID_ACCESS, c.rating as ContentRating));
    return delay({ items: items.map((c) => (c.title === "How to Catch a Dinosaur" ? { ...c, inLibrary: { id: "b1" } } : c)), hiddenForAge: all - items.length }, 300);
  },
  async list(scope, status) {
    const w = who();
    let rows = requests;
    if (scope === "mine") rows = rows.filter((r) => r.requestedBy?.id === meId());
    else if (scope === "approvals") rows = w === "admin" ? rows : w === "adult" ? rows.filter((r) => r.requestedBy?.role === "kid") : [];
    if (status?.length) rows = rows.filter((r) => status.includes(r.status));
    return delay({ items: rows.map(view), total: rows.length });
  },
  async summary() {
    const w = who();
    const toApprove = requests.filter((r) => r.status === "pending" && (w === "admin" || (w === "adult" && r.requestedBy?.role === "kid"))).length;
    return delay({ open: requests.filter((r) => r.requestedBy?.id === meId() && ["pending", "approved", "downloading"].includes(r.status)).length, toApprove });
  },
  async create(input) {
    const w = who();
    const known = candidates.find((c) => c.title.toLowerCase() === input.title.toLowerCase());
    if (known?.title === "How to Catch a Dinosaur") return delay({ kind: "owned" as const, book: { id: "b1", title: known.title } });
    const rating = known?.rating ?? null;
    let status: RequestStatus = w === "admin" ? "approved" : "pending";
    let note = input.note ?? null;
    if (w === "kid" && rating && !canSee(KID_ACCESS, rating)) {
      status = "declined";
      note = "This book is above your reading level.";
    }
    const r = req(
      {
        ...input,
        author: input.author ?? null,
        isbn13: input.isbn13 ?? null,
        publishedYear: input.publishedYear ?? null,
        coverUrl: input.coverUrl ?? cover(input.title, requests.length),
        rating,
        ratingReason: known?.ratingReason ?? null,
        status,
        note,
        createdAt: Date.now(),
      },
      w === "kid" ? "Mia" : "Sam",
      requests.length,
    );
    requests = [r, ...requests];
    return delay({ kind: "created" as const, request: view(r), duplicate: false }, 300);
  },
  async approve(id, note) {
    const r = requests.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "Not found");
    const auto = settings.autoDownload && settings.available.length > 0;
    Object.assign(r, {
      status: auto ? "downloading" : "approved",
      note: note ?? null,
      decidedBy: { id: "u-adult", displayName: "Sam" },
      decidedAt: Date.now(),
      download: auto ? { jobId: "j1", status: "queued", progress: null, error: null } : null,
    });
    return delay(view(r));
  },
  async decline(id, note) {
    const r = requests.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "Not found");
    Object.assign(r, { status: "declined", note: note ?? null, decidedBy: { id: "u-adult", displayName: "Sam" }, decidedAt: Date.now() });
    return delay(view(r));
  },
  async withdraw(id) {
    requests = requests.filter((r) => r.id !== id);
    return delay(undefined);
  },
  async startDownload(id) {
    adminOnly();
    const r = requests.find((x) => x.id === id)!;
    Object.assign(r, { status: "downloading", download: { jobId: "j1", status: "queued", progress: null, error: null } });
    return delay(view(r));
  },
  async jobs(q = {}) {
    adminOnly();
    const rows = jobs.filter((j) => (!q.status || j.status === q.status) && (!q.type || j.type === q.type));
    const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const j of jobs) counts[j.status]++;
    return delay({ items: rows.map(strip), total: rows.length, counts, types: ["downloads.fetch", "library.scan"] });
  },
  async job(id) {
    adminOnly();
    const j = jobs.find((x) => x.id === id);
    if (!j) throw new ApiError(404, "Not found");
    return delay(j);
  },
  async retryJob(id) {
    const j = jobs.find((x) => x.id === id)!;
    Object.assign(j, { status: "queued", attempts: 0, lastError: null });
    return delay(strip(j));
  },
  async cancelJob(id) {
    const j = jobs.find((x) => x.id === id)!;
    Object.assign(j, { status: "cancelled", lastError: "Cancelled" });
    return delay(strip(j));
  },
  async settings() {
    adminOnly();
    return delay(settings);
  },
  async saveSettings(s) {
    adminOnly();
    const keep = <T extends { hasApiKey: boolean } | null>(cur: T, next: { apiKey?: string } | null | undefined) =>
      next === undefined ? cur : next === null ? null : { ...cur, ...next, hasApiKey: !!next.apiKey || !!cur?.hasApiKey };
    settings = {
      ...settings,
      autoDownload: s.autoDownload ?? settings.autoDownload,
      order: s.order ?? settings.order,
      shelfmark: keep(settings.shelfmark, s.shelfmark) as DownloadSettings["shelfmark"],
      sabnzbd: keep(settings.sabnzbd, s.sabnzbd) as DownloadSettings["sabnzbd"],
      newznab: keep(settings.newznab, s.newznab) as DownloadSettings["newznab"],
      direct: { ...settings.direct, ...s.direct },
      uploads: { ...settings.uploads, ...s.uploads },
    };
    settings.available = settings.order.filter((d) => (d === "shelfmark" ? settings.shelfmark?.enabled : settings.sabnzbd?.enabled && settings.newznab?.enabled));
    return delay(settings);
  },
  async testClient(client) {
    return delay(
      client === "shelfmark"
        ? { ok: true, message: "Shelfmark answered and accepted the API key." }
        : client === "sabnzbd"
          ? { ok: true, message: "sabnzbd 4.3.2 answered and accepted the API key." }
          : { ok: false, message: "No Newznab indexer is set up" },
      400,
    );
  },
  async directDownload(url, title) {
    adminOnly();
    const j: JobDetail = { ...jobs[0]!, id: `j${jobs.length + 1}`, label: `Download: ${title || url}`, status: "queued", progress: null, logs: [], createdAt: Date.now() };
    jobs.unshift(j);
    return delay(strip(j));
  },
  async uploadAllowed() {
    return delay({ allowed: who() === "admin" || (who() === "adult" && settings.uploads.allowAdults), maxMb: settings.uploads.maxMb });
  },
  async upload(file, onProgress) {
    for (let i = 1; i <= 5; i++) {
      await delay(null, 120);
      onProgress?.(i / 5);
    }
    return { files: [`_incoming/uploads/demo/${file.name}`], scanJobId: "j4" };
  },
};
