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
  /** Why it's here: "Book 3 of Mistborn", "Also by Ann Leckie", "Caldecott Medal 2024". */
  note?: string;
  /** Not in the library and this reader may ask for it (shows Request it). */
  requestable?: boolean;
}

/** Section of the page a row belongs to. */
export type DiscoverGroup = "foryou" | "popular" | "genres" | "awards" | "family";

export interface DiscoverList {
  id: string;
  name: string;
  source: DiscoverItem["source"] | "foryou" | "awards";
  group?: DiscoverGroup;
  items: DiscoverItem[];
  /** A library book the row is about ("Because you read …" links to it). */
  aboutBookId?: string;
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

export type CategoryKind = "genre" | "subject" | "section" | "custom";

export interface Category {
  id: string;
  name: string;
  kind: Exclude<CategoryKind, "subject">;
  bookCount: number;
  cookbook: boolean;
  books: BookSummary[];
}

export interface CategoryPage {
  category: Omit<Category, "bookCount" | "books">;
  items: BookSummary[];
  total: number;
}

/** A row on the admin's manage-categories page (raw subjects included). */
export interface ManagedCategory {
  id: string;
  name: string;
  kind: CategoryKind;
  bookCount: number;
  hidden: boolean;
  /** One of the curated categories books are filed under automatically. */
  curated: boolean;
  /** Whether the Categories page lists it (not hidden, not a subject, enough books). */
  shown: boolean;
  /** Old names (merged or renamed away) that now land here. */
  aliases: string[];
}

export interface ManagedCategories {
  items: ManagedCategory[];
  counts: Partial<Record<CategoryKind, number>>;
  minBooks: number;
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

/**
 * sent: request created. in_library: the server found a book this reader can already open
 * (409 already_in_library). unavailable: requests aren't switched on on this server.
 */
export type RequestResult =
  | { status: "sent" }
  | { status: "in_library"; book: { id: string; title: string } }
  | { status: "unavailable" };

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
  manageCategories(kind: CategoryKind | "all" | "categories", q?: string): Promise<ManagedCategories>;
  updateCategory(id: string, patch: { name?: string; hidden?: boolean; kind?: "genre" | "subject" }): Promise<{ id: string; merged: boolean }>;
  mergeCategory(id: string, into: string): Promise<{ id: string; bookCount: number }>;
  setCategoryMinBooks(minBooks: number): Promise<void>;
  rebuildCategories(): Promise<{ books: number; linked: number; refiled?: number; unsure?: number; rechecking?: number }>;
  kindleImport(csv: string, opts: { rating?: ContentRating; dryRun?: boolean }): Promise<KindleImportReport>;
  /** Hands a "Request it" to the requests workstream (POST /api/requests). */
  requestBook(input: BookRequestInput): Promise<RequestResult>;
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
  manageCategories: (kind, q) => request(`/api/admin/categories?${new URLSearchParams({ kind, ...(q ? { q } : {}) })}`),
  updateCategory: (id, patch) => request(`/api/categories/${enc(id)}`, { method: "PATCH", body: json(patch) }),
  mergeCategory: (id, into) => request(`/api/categories/${enc(id)}/merge`, { method: "POST", body: json({ into }) }),
  setCategoryMinBooks: async (minBooks) => {
    await request("/api/admin/categories/settings", { method: "PUT", body: json({ minBooks }) });
  },
  rebuildCategories: () => request("/api/admin/categories/rebuild", { method: "POST" }),
  kindleImport: (csv, opts) => request("/api/admin/kindle/import", { method: "POST", body: json({ csv, ...opts }) }),
  requestBook: async (input) => {
    const res = await fetch("/api/requests", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: json(input),
    });
    if (res.ok) return { status: "sent" };
    // A server without the requests feature yet.
    if (res.status === 404 || res.status === 405) return { status: "unavailable" };
    const body = (await res.json().catch(() => null)) as
      | { error?: string; message?: string; book?: { id: string; title: string } }
      | null;
    if (res.status === 409 && body?.error === "already_in_library" && body.book?.id)
      return { status: "in_library", book: body.book };
    throw new ApiError(res.status, body?.message ?? `HTTP ${res.status}`);
  },
};

export const discoverApi: DiscoverApi = isDemo ? demoDiscoverApi : httpDiscoverApi;
