/**
 * Server calls for Discover, series, categories and the Kindle import. Kept in this folder (not
 * api/client.ts) so this workstream doesn't collide with others; it reuses ApiError and the demo
 * switch from there. Endpoints are documented in docs/discover-api.md.
 */
import type { ContentRating, DiscoverStatus } from "@bookbandit/shared";
import { ApiError, isDemo } from "../api/client";
import type { BookSummary } from "../api/types";
import { demoDiscoverApi } from "./demo";

export interface DiscoverItem {
  key: string;
  title: string;
  authors: string[];
  year: number | null;
  coverUrl: string | null;
  source: "openlibrary" | "hardcover" | "library";
  url: string;
  isbn13: string | null;
  status: DiscoverStatus;
  bookId: string | null;
  coverPath: string | null;
  onKindle: boolean;
}

export interface DiscoverList {
  id: string;
  name: string;
  source: DiscoverItem["source"];
  items: DiscoverItem[];
  error?: string;
}

export interface DiscoverResponse {
  lists: DiscoverList[];
  /** false when the server has METADATA_ONLINE=false */
  online: boolean;
  /** Whether this reader sees outside books (and the Request button) at all. */
  requests: boolean;
}

export interface SeriesBook extends BookSummary {
  position: number | null;
}

export interface SeriesSummary {
  id: string;
  name: string;
  description: string | null;
  adminManaged: boolean;
  bookCount: number;
  books: SeriesBook[];
}

export interface SeriesDetail {
  id: string;
  name: string;
  description: string | null;
  adminManaged: boolean;
  books: SeriesBook[];
}

export interface Category {
  id: string;
  name: string;
  kind: "genre" | "section" | "custom";
  bookCount: number;
  cookbook: boolean;
  books: BookSummary[];
}

export interface CategoryPage {
  category: Omit<Category, "bookCount" | "books">;
  items: BookSummary[];
  total: number;
}

export interface KindleImportReport {
  rows: number;
  created: number;
  linked: number;
  skipped: number;
  errors: string[];
  dryRun: boolean;
}

export interface BookRequestInput {
  title: string;
  author: string | null;
  isbn13: string | null;
}

export interface DiscoverApi {
  discover(): Promise<DiscoverResponse>;
  seriesList(q?: string): Promise<{ items: SeriesSummary[]; total: number }>;
  series(id: string): Promise<SeriesDetail>;
  createSeries(name: string, bookIds: string[]): Promise<{ id: string }>;
  updateSeries(id: string, patch: { name?: string; description?: string | null }): Promise<void>;
  setSeriesBooks(id: string, books: { bookId: string; position?: number | null }[]): Promise<SeriesBook[]>;
  deleteSeries(id: string): Promise<void>;
  categories(): Promise<Category[]>;
  category(id: string, offset?: number): Promise<CategoryPage>;
  bookCategories(bookId: string): Promise<{ items: Omit<Category, "bookCount" | "books">[]; cookbook: boolean }>;
  kindleImport(csv: string, opts: { rating?: ContentRating; dryRun?: boolean }): Promise<KindleImportReport>;
  /** Hands a "Request it" to the requests workstream; resolves false if requests aren't available yet. */
  requestBook(input: BookRequestInput): Promise<boolean>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const enc = encodeURIComponent;
const json = (body: unknown) => JSON.stringify(body);

export const httpDiscoverApi: DiscoverApi = {
  discover: () => request("/api/discover"),
  seriesList: (q) => request(`/api/series?${new URLSearchParams({ limit: "100", ...(q ? { q } : {}) })}`),
  series: (id) => request(`/api/series/${enc(id)}`),
  createSeries: (name, bookIds) =>
    request("/api/series", { method: "POST", body: json({ name, books: bookIds.map((bookId) => ({ bookId })) }) }),
  updateSeries: async (id, patch) => {
    await request(`/api/series/${enc(id)}`, { method: "PATCH", body: json(patch) });
  },
  setSeriesBooks: (id, books) =>
    request<{ books: SeriesBook[] }>(`/api/series/${enc(id)}/books`, { method: "PUT", body: json({ books }) }).then(
      (r) => r.books,
    ),
  deleteSeries: (id) => request(`/api/series/${enc(id)}`, { method: "DELETE" }),
  categories: () => request<{ items: Category[] }>("/api/categories").then((r) => r.items),
  category: (id, offset = 0) => request(`/api/categories/${enc(id)}?${new URLSearchParams({ offset: String(offset) })}`),
  bookCategories: (bookId) => request(`/api/books/${enc(bookId)}/categories`),
  kindleImport: (csv, opts) => request("/api/admin/kindle/import", { method: "POST", body: json({ csv, ...opts }) }),
  requestBook: async (input) => {
    try {
      await request("/api/requests", { method: "POST", body: json(input) });
      return true;
    } catch (e) {
      // TODO(requests): drop this once ws/requests ships POST /api/requests.
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return false;
      throw e;
    }
  },
};

export const discoverApi: DiscoverApi = isDemo ? demoDiscoverApi : httpDiscoverApi;
