/**
 * Move-in imports (admin): Calibre, Calibre-Web, Kavita, Goodreads/StoryGraph, Google Play Books.
 * Server side: apps/server/src/imports (README there lists the endpoints).
 */
import type { ContentRating } from "@bookbandit/shared";
import { isDemo, request } from "../api/client";
import { demoImportsApi } from "./demo";

export type ImportSource = "calibre" | "calibre-web" | "kavita" | "goodreads" | "google-play";
export type ItemStatus = "matched" | "new" | "skipped" | "conflict";
export type FileRef = { path: string } | { uploadId: string };

export interface ReportItem {
  status: ItemStatus;
  title: string;
  detail?: string;
}

export interface SourcePerson {
  id: string;
  name: string;
  email?: string | null;
  userId: string | null;
  guessed: boolean;
}

export interface ImportReport {
  source: ImportSource | "storygraph";
  dryRun: boolean;
  counts: Record<ItemStatus, number>;
  stats: Record<string, number>;
  items: ReportItem[];
  warnings: string[];
  people?: SourcePerson[];
}

export interface ImportJob {
  id: string;
  source: ImportSource | null;
  dryRun: boolean;
  label: string | null;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: number | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  report: ImportReport | null;
}

export interface PastImport extends Omit<ImportJob, "report"> {
  report: { source: string; dryRun: boolean; counts: Record<ItemStatus, number>; stats: Record<string, number>; warnings: number } | null;
}

export interface HouseholdPerson {
  id: string;
  displayName: string;
  role: string;
}

export type ImportRequest =
  | { source: "calibre"; dryRun: boolean; metadataDb: FileRef; overwrite: "calibre" | "fill-gaps"; covers: boolean; approve: boolean }
  | { source: "calibre-web"; dryRun: boolean; appDb: FileRef; metadataDb?: FileRef; people: Record<string, string | null>; shelves: boolean }
  | { source: "kavita"; dryRun: boolean; url: string; accounts: { apiKey: string; userId: string | null }[]; collections: boolean }
  | { source: "goodreads"; dryRun: boolean; file: { uploadId: string }; userId: string; markFinished: boolean; wantToRead: boolean; shelves: boolean }
  | { source: "google-play"; dryRun: boolean; file: { uploadId: string }; rating?: ContentRating };

export interface ImportsApi {
  people(): Promise<{ items: HouseholdPerson[] }>;
  upload(file: File): Promise<{ uploadId: string; name: string | null; size: number }>;
  start(body: ImportRequest): Promise<{ jobId: string }>;
  job(id: string): Promise<ImportJob>;
  list(): Promise<{ items: PastImport[] }>;
  exportUrl(userId?: string): string;
  elsewhere(bookId: string): Promise<{ googlePlay: { url: string | null } | null }>;
}

const httpImportsApi: ImportsApi = {
  people: () => request("/api/admin/imports/people"),
  upload: (file) =>
    request(`/api/admin/imports/uploads?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
      headers: { "Content-Type": "application/octet-stream" },
    }),
  start: (body) => request("/api/admin/imports", { method: "POST", body: JSON.stringify(body) }),
  job: (id) => request(`/api/admin/imports/${encodeURIComponent(id)}`),
  list: () => request("/api/admin/imports"),
  exportUrl: (userId) => `/api/reading-history/export.csv${userId ? `?userId=${encodeURIComponent(userId)}` : ""}`,
  elsewhere: (bookId) => request(`/api/books/${encodeURIComponent(bookId)}/elsewhere`),
};

export const importsApi: ImportsApi = isDemo ? demoImportsApi : httpImportsApi;
