import { DEFAULT_THEME, isThemeId, maxAllowedRating, type ProgressUpdate, type Role, type ThemeId } from "@bookbandit/shared";
import type {
  Bookmark,
  BookDetail,
  BookSummary,
  Me,
  NewBookmark,
  Page,
  ProgressBatchResult,
  ProgressPutResult,
  ProgressRecord,
  Shelf,
} from "./types";
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

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

/** What GET /api/users/me returns (family accounts workstream). */
interface UserMe {
  id: string;
  displayName: string;
  role: Role;
  avatar: string | null;
  theme: string;
  birthYear: number | null;
  explicitOptIn: boolean;
}

/** The UI's view of the signed-in reader. maxRating only trims filter options; the server enforces it. */
export function toMe(u: UserMe, today: Date = new Date()): Me {
  const isKid = u.role === "kid";
  return {
    id: u.id,
    displayName: u.displayName,
    role: u.role,
    isKid,
    avatar: u.avatar,
    theme: themeIdOr(u.theme),
    maxRating: maxAllowedRating({ birthYear: u.birthYear, isKid, explicitOptIn: !isKid && u.explicitOptIn }, today),
  };
}

function themeIdOr(t: string): ThemeId {
  return isThemeId(t) ? t : DEFAULT_THEME;
}

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
  putProgress(update: ProgressUpdate, opts?: { keepalive?: boolean }): Promise<ProgressPutResult>;
  putProgressBatch(updates: ProgressUpdate[]): Promise<ProgressBatchResult>;
  bookmarks(bookId: string): Promise<Bookmark[]>;
  addBookmark(b: NewBookmark): Promise<Bookmark>;
  deleteBookmark(id: string): Promise<void>;
}

export const httpApi: Api = {
  me: () => request<UserMe>("/api/users/me").then(toMe),
  setTheme: async (theme) => {
    await request("/api/users/me", { method: "PATCH", body: json({ theme }) });
  },

  /** Home rows. Shelf ids: continue, recent, kid, series:<id>, collection:<id>, tag:<id>. */
  shelves: () => request<{ items: Shelf[] }>("/api/shelves").then((r) => r.items),
  books: (query) => request(`/api/books?${query}`),
  authors: (q) =>
    request<{ items: { id: string; name: string }[] }>(`/api/authors?${new URLSearchParams({ q, limit: "20" })}`).then(
      (r) => r.items,
    ),
  book: (id) => request(`/api/books/${encodeURIComponent(id)}`),
  coverUrl: (b) => (b.coverPath ? `/api/books/${encodeURIComponent(b.id)}/cover` : null),
  fileUrl: (bookId, fileId) => `/api/books/${encodeURIComponent(bookId)}/files/${encodeURIComponent(fileId)}`,
  getProgress: (bookId) =>
    request<{ progress: ProgressRecord | null }>(`/api/progress/${encodeURIComponent(bookId)}`).then((r) => r.progress),
  putProgress: (update, opts) => {
    const { bookId, ...body } = update;
    return request(`/api/progress/${encodeURIComponent(bookId)}`, {
      method: "PUT",
      body: json(body),
      keepalive: opts?.keepalive,
    });
  },
  putProgressBatch: (updates) => request("/api/progress/batch", { method: "POST", body: json({ updates }) }),
  bookmarks: (bookId) =>
    request<{ items: Bookmark[] }>(`/api/books/${encodeURIComponent(bookId)}/bookmarks`).then((r) => r.items),
  addBookmark: (b) => request("/api/bookmarks", { method: "POST", body: json({ id: crypto.randomUUID(), ...b }) }),
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
