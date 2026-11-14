import type { ProgressUpdate, ThemeId } from "@bookbandit/shared";
import type { Bookmark, BookDetail, BookSummary, Me, NewBookmark, Page, ProgressRecord, Shelf } from "./types";
import { demoApi } from "./demo";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
  /** Locked and missing books both come back as 404 by design. */
  get notFound() {
    return this.status === 404;
  }
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

const json = (body: unknown) => JSON.stringify(body);

/**
 * Everything the web app asks the server for. The endpoint list is written down in
 * `apps/web/API_CONTRACT.md` so the server workstreams can match it.
 */
export interface Api {
  me(): Promise<Me>;
  setTheme(theme: ThemeId): Promise<void>;
  shelves(): Promise<Shelf[]>;
  books(query: URLSearchParams): Promise<Page<BookSummary>>;
  authors(q: string): Promise<{ id: string; name: string }[]>;
  book(id: string): Promise<BookDetail>;
  coverUrl(book: Pick<BookSummary, "id" | "coverPath">): string | null;
  fileUrl(bookId: string, fileId: string): string;
  getProgress(bookId: string): Promise<ProgressRecord | null>;
  putProgress(update: ProgressUpdate, opts?: { keepalive?: boolean }): Promise<void>;
  bookmarks(bookId: string): Promise<Bookmark[]>;
  addBookmark(b: NewBookmark): Promise<Bookmark>;
  deleteBookmark(id: string): Promise<void>;
}

export const httpApi: Api = {
  me: () => request("/api/me"),
  setTheme: (theme) => request("/api/me", { method: "PATCH", body: json({ theme }) }),
  shelves: () => request<{ items: Shelf[] }>("/api/shelves").then((r) => r.items),
  books: (query) => request(`/api/books?${query}`),
  authors: (q) =>
    request<{ items: { id: string; name: string }[] }>(`/api/authors?${new URLSearchParams({ q, limit: "20" })}`).then(
      (r) => r.items,
    ),
  book: (id) => request(`/api/books/${encodeURIComponent(id)}`),
  coverUrl: (b) => (b.coverPath ? `/api/books/${encodeURIComponent(b.id)}/cover` : null),
  fileUrl: (bookId, fileId) => `/api/books/${encodeURIComponent(bookId)}/files/${encodeURIComponent(fileId)}`,
  getProgress: async (bookId) => {
    try {
      return await request<ProgressRecord>(`/api/progress/${encodeURIComponent(bookId)}`);
    } catch (e) {
      if (e instanceof ApiError && e.notFound) return null;
      throw e;
    }
  },
  putProgress: (update, opts) =>
    request(`/api/progress/${encodeURIComponent(update.bookId)}`, {
      method: "PUT",
      body: json(update),
      keepalive: opts?.keepalive,
    }),
  bookmarks: (bookId) =>
    request<{ items: Bookmark[] }>(`/api/bookmarks?${new URLSearchParams({ bookId })}`).then((r) => r.items),
  addBookmark: (b) => request("/api/bookmarks", { method: "POST", body: json(b) }),
  deleteBookmark: (id) => request(`/api/bookmarks/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/** `VITE_DEMO=1 pnpm dev` (or `?demo` in the URL) runs the UI on sample data without a server. */
function demoWanted(): boolean {
  if (import.meta.env.VITE_DEMO === "1") return true;
  try {
    return new URLSearchParams(window.location.search).has("demo") || sessionStorage.getItem("bb-demo") === "1";
  } catch {
    return false;
  }
}

export const isDemo = typeof window !== "undefined" && demoWanted();
if (isDemo) {
  try {
    sessionStorage.setItem("bb-demo", "1");
  } catch {
    /* ignore */
  }
}

export const api: Api = isDemo ? demoApi : httpApi;
