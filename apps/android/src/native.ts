import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/** Synchronous state the native side writes into /native/state.js before the page starts. */
export interface NativeBoot {
  platform: "android";
  paired: boolean;
  server: string | null;
  deviceName: string;
  hasPin: boolean;
  appVersion: string;
}

declare global {
  interface Window {
    __BB_NATIVE__?: NativeBoot;
  }
}

export interface NativeState {
  paired: boolean;
  server: string | null;
  deviceName: string;
  deviceId: string | null;
  lockedToPerson: boolean;
  hasPin: boolean;
  autoPinKids: boolean;
  pinned: boolean;
  appVersion: string;
  pendingPairLink: string | null;
  userId: string | null;
  role: string | null;
}

export type DownloadStatus = "none" | "queued" | "downloading" | "done" | "error";

export interface DownloadEvent {
  status: DownloadStatus;
  bookId: string;
  received: number;
  total: number;
  error?: string;
}

export interface DownloadedBook {
  bookId: string;
  fileId: string;
  title: string;
  format: string;
  sizeBytes: number;
  downloadedAt: number;
}

export interface NativeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  bodyBase64?: string;
}

export interface NativeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The Java side: apps/android/android/app/src/main/java/app/bookbandit/tablet/BookBanditPlugin.java */
export interface BookBanditPlugin {
  getState(): Promise<NativeState>;
  pair(o: { server: string; code: string; name: string; pin?: string }): Promise<{ deviceName: string; lockedToPerson: boolean }>;
  unpair(o: { pin?: string }): Promise<void>;
  request(o: NativeRequest): Promise<NativeResponse>;
  download(o: { bookId: string; fileId: string }): Promise<DownloadEvent>;
  removeDownload(o: { bookId: string }): Promise<void>;
  listDownloads(): Promise<{ items: DownloadedBook[]; usedBytes: number; freeBytes: number }>;
  downloadStatus(o: { bookId: string }): Promise<DownloadEvent>;
  pinScreen(): Promise<void>;
  unpinScreen(o: { pin?: string }): Promise<void>;
  checkPin(o: { pin?: string }): Promise<void>;
  setPin(o: { oldPin?: string; newPin: string }): Promise<void>;
  setAutoPinKids(o: { value: boolean; pin?: string }): Promise<void>;
  addListener(event: "download", cb: (e: DownloadEvent) => void): Promise<PluginListenerHandle>;
}

export const BookBandit = registerPlugin<BookBanditPlugin>("BookBandit", {
  // Only for previews in a desktop browser; on the tablet Capacitor calls the Java plugin.
  web: () => import("./mockPlugin").then((m) => new m.MockBookBandit()),
});

/** Capacitor rejects with { code, message, data }. */
export function errorCode(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function retryAfterMs(e: unknown): number {
  return Number((e as { data?: { retryAfterMs?: number } } | null)?.data?.retryAfterMs ?? 0);
}

/** Same preference order as the web reader (apps/web/src/reader/formats.ts). */
const READABLE_ORDER = ["epub", "azw3", "mobi", "fb2", "cbz", "pdf"];

export function pickReadableFile<T extends { id: string; format: string }>(files: T[] | undefined): T | null {
  if (!files?.length) return null;
  for (const f of READABLE_ORDER) {
    const hit = files.find((x) => x.format === f);
    if (hit) return hit;
  }
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
