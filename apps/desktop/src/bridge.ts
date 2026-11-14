/**
 * Calls into the native side. In a plain browser (Vite dev without Tauri, tests, screenshots)
 * a small in-memory mock answers instead, so the pages can be worked on and captured anywhere.
 */
import { invoke } from "@tauri-apps/api/core";
import { mockInvoke } from "./mock";

export interface AppInfo {
  serverUrl: string | null;
  deviceName: string;
  version: string;
}

export interface UserInfo {
  id: string;
  displayName: string;
  role: string;
}

export type Locator =
  | { kind: "epub"; cfi: string; percent: number }
  | { kind: "page"; page: number; totalPages: number };

export interface OfflineBook {
  bookId: string;
  ownerId: string;
  title: string;
  authors: string[];
  format: string;
  fileName: string;
  hasCover: boolean;
  sizeBytes: number;
  savedAt: number;
  progress: { locator: Locator; percent: number; finished: boolean; updatedAt: number; deviceName: string | null } | null;
}

export interface Library {
  user: UserInfo | null;
  books: OfflineBook[];
  pending: number;
}

export interface SyncReport {
  signedIn: boolean;
  uploaded: number;
  updatedFromServer: number;
  removed: number;
}

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return inTauri ? invoke<T>(cmd, args) : mockInvoke<T>(cmd, args);
}

/** Native errors arrive as plain strings. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const native = {
  appInfo: () => call<AppInfo>("app_info"),
  connect: (address: string, code?: string) => call<string>("connect", { address, code: code || null }),
  openServer: (path?: string) => call<void>("open_server", { path: path ?? null }),
  serverReachable: () => call<boolean>("server_reachable"),
  library: () => call<Library>("offline_library"),
  file: (bookId: string) => call<ArrayBuffer>("offline_file", { bookId }),
  cover: (bookId: string) => call<ArrayBuffer>("offline_cover", { bookId }),
  saveProgress: (bookId: string, locator: Locator, percent: number, finished: boolean) =>
    call<void>("offline_progress", { bookId, locator, percent, finished }),
  remove: (bookId: string) => call<void>("offline_remove", { bookId }),
  sync: () => call<SyncReport>("sync_now"),
};
