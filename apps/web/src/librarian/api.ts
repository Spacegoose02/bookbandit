/**
 * What the librarian pages ask the server for (apps/server/src/librarian/routes.ts). Same request
 * helper and demo switch as the admin pages.
 */
import type { ContentRating } from "@bookbandit/shared";
import { isDemo, request } from "../api/client";
import type { PageOf } from "../admin/api";
import { demoLibrarianApi } from "./demo";

const json = (body: unknown) => JSON.stringify(body);
const enc = encodeURIComponent;

export interface LibFile {
  id: string;
  relPath: string;
  format: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface LibBook {
  id: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  series: { id: string; name: string; position: number | null } | null;
  tags: { name: string; kind: string }[];
  language: string | null;
  publishedYear: number | null;
  isbn13: string | null;
  publisher: string | null;
  description: string | null;
  coverPath: string | null;
  rating: ContentRating | null;
  ratingSource: string | null;
  approved: boolean;
  kindleOnly: boolean;
  files: LibFile[];
  addedAt: number;
  updatedAt: number | null;
}

export type DuplicateReason = "isbn" | "title_author" | "title";

export interface WorkGroup {
  key: string;
  reason: DuplicateReason;
  books: (LibBook & { readers: number; bookmarks: number })[];
}

export interface CopyGroup {
  sha256: string;
  sizeBytes: number;
  files: { id: string; relPath: string; format: string; bookId: string; bookTitle: string }[];
}

export interface Duplicates {
  sameWork: WorkGroup[];
  copies: CopyGroup[];
  ignored: number;
}

export const HEALTH_CHECKS = ["no_cover", "no_rating", "no_author", "no_files"] as const;
export type HealthCheck = (typeof HEALTH_CHECKS)[number];

export interface FileProblem {
  fileId: string;
  bookId: string;
  title: string;
  relPath: string;
  format: string;
  problem: "missing" | "unreadable" | "drm";
  detail?: string;
}

export interface Health {
  counts: Record<HealthCheck, number>;
  files: { checkedAt: number; filesChecked: number; problems: FileProblem[] } | null;
  running: { id: string; status: string; progress: number | null } | null;
}

export interface LibJob {
  id: string;
  type: string;
  label: string | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number | null;
  lastError: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface Tools {
  ebookConvert: boolean;
  kepubify: boolean;
  needsConversion: number;
  epubBooks: number;
  settings: { writeMetadata: boolean };
  jobs: LibJob[];
}

export interface BookQuery {
  q?: string;
  check?: HealthCheck;
  format?: string;
  sort?: "title" | "added";
  offset?: number;
  limit?: number;
}

export interface BulkChange {
  ids: string[];
  series?: { name: string; numbering: "keep" | "sequence" | "clear"; start?: number } | null;
  tagsAdd?: string[];
  tagsRemove?: string[];
  rating?: ContentRating | null;
  authors?: string[];
  language?: string | null;
}

export interface CoverCandidate {
  source: "file" | "openlibrary" | "google" | "hardcover" | "isbndb";
  label: string;
  url: string;
  fileId?: string;
}

export type CoverChoice = { url: string } | { fileId: string } | { image: string };

export interface LibrarianApi {
  books(q: BookQuery): Promise<PageOf<LibBook>>;
  series(): Promise<{ id: string; name: string; books: number }[]>;
  bulk(change: BulkChange): Promise<{ updated: number; writeMetadataJobs: number; items: LibBook[] }>;
  duplicates(): Promise<Duplicates>;
  mergeDuplicates(keepId: string, otherIds: string[]): Promise<void>;
  keepDuplicate(keepId: string, otherIds: string[]): Promise<{ setAside: string[] }>;
  removeCopies(fileIds: string[]): Promise<{ setAside: string[] }>;
  ignoreDuplicates(bookIds: string[]): Promise<void>;
  clearIgnored(): Promise<void>;
  tools(): Promise<Tools>;
  convertible(): Promise<LibBook[]>;
  convert(bookIds: string[]): Promise<{ queued: { bookId: string; jobId: string }[]; skipped: { bookId: string; reason: string }[] }>;
  prepareKobo(bookIds?: string[]): Promise<{ jobId: string }>;
  setWriteMetadata(on: boolean): Promise<{ writeMetadata: boolean }>;
  writeMetadata(bookIds: string[]): Promise<{ queued: number }>;
  covers(bookId: string): Promise<{ current: string | null; candidates: CoverCandidate[]; errors: string[] }>;
  setCover(bookId: string, choice: CoverChoice): Promise<LibBook>;
  health(): Promise<Health>;
  checkFiles(): Promise<{ jobId: string }>;
  /** Admin view of a book's cover (works for inbox and locked books too); null when it has none. */
  coverUrl(b: { id: string; coverPath: string | null; updatedAt?: number | null }): string | null;
}

function qs(q: BookQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  return p.toString();
}

export const httpLibrarianApi: LibrarianApi = {
  books: (q) => request(`/api/admin/librarian/books?${qs(q)}`),
  series: () => request<{ series: { id: string; name: string; books: number }[] }>("/api/admin/librarian/series").then((r) => r.series),
  bulk: (change) => request("/api/admin/librarian/bulk", { method: "POST", body: json(change) }),
  duplicates: () => request("/api/admin/librarian/duplicates"),
  async mergeDuplicates(keepId, otherIds) {
    await request("/api/admin/librarian/duplicates/merge", { method: "POST", body: json({ keepId, otherIds }) });
  },
  keepDuplicate: (keepId, otherIds) => request("/api/admin/librarian/duplicates/keep", { method: "POST", body: json({ keepId, otherIds }) }),
  removeCopies: (fileIds) => request("/api/admin/librarian/duplicates/copies", { method: "POST", body: json({ fileIds }) }),
  async ignoreDuplicates(bookIds) {
    await request("/api/admin/librarian/duplicates/ignore", { method: "POST", body: json({ bookIds }) });
  },
  async clearIgnored() {
    await request("/api/admin/librarian/duplicates/ignore", { method: "DELETE" });
  },
  tools: () => request("/api/admin/librarian/tools"),
  convertible: () => request<{ items: LibBook[] }>("/api/admin/librarian/convertible").then((r) => r.items),
  convert: (bookIds) => request("/api/admin/librarian/convert", { method: "POST", body: json({ bookIds, to: "epub" }) }),
  prepareKobo: (bookIds) => request("/api/admin/librarian/kepub", { method: "POST", body: json(bookIds?.length ? { bookIds } : {}) }),
  setWriteMetadata: (on) => request("/api/admin/librarian/settings", { method: "PUT", body: json({ writeMetadata: on }) }),
  writeMetadata: (bookIds) => request("/api/admin/librarian/write-metadata", { method: "POST", body: json({ bookIds }) }),
  covers: (bookId) => request(`/api/admin/librarian/books/${enc(bookId)}/covers`),
  setCover: (bookId, choice) =>
    request<{ book: LibBook }>(`/api/admin/librarian/books/${enc(bookId)}/cover`, { method: "POST", body: json(choice) }).then((r) => r.book),
  health: () => request("/api/admin/librarian/health"),
  checkFiles: () => request("/api/admin/librarian/health/check", { method: "POST" }),
  coverUrl: (b) => (b.coverPath ? `/api/admin/librarian/books/${enc(b.id)}/cover?v=${b.updatedAt ?? 0}` : null),
};

export const librarianApi: LibrarianApi = isDemo ? demoLibrarianApi : httpLibrarianApi;

export const CHECK_LABELS: Record<HealthCheck, { title: string; hint: string }> = {
  no_cover: { title: "No cover", hint: "Pick one from the lookup, the file, or upload your own" },
  no_rating: { title: "No rating", hint: "Hidden from kids until rated" },
  no_author: { title: "No author", hint: "Set authors in bulk from Edit books" },
  no_files: { title: "Files gone", hint: "Every file was moved or deleted; rescan or remove" },
};

export const REASON_LABELS: Record<DuplicateReason, string> = {
  isbn: "Same ISBN",
  title_author: "Same title and author",
  title: "Same title, an author is missing",
};
