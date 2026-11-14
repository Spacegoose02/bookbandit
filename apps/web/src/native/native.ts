/**
 * What the Android tablet app adds to the page (apps/android/src/shim.ts). Undefined in a normal
 * browser, so everything here is optional UI that only appears inside the tablet app.
 */
export type DownloadStatus = "none" | "queued" | "downloading" | "done" | "error";

export interface DownloadEvent {
  status: DownloadStatus;
  bookId: string;
  received: number;
  total: number;
  error?: string;
}

export interface BookBanditNative {
  platform: "android";
  appVersion: string;
  deviceName: string;
  download(bookId: string, fileId: string): Promise<void>;
  removeDownload(bookId: string): Promise<void>;
  downloadStatus(bookId: string): Promise<DownloadStatus>;
  onDownload(cb: (e: DownloadEvent) => void): () => void;
  pinScreen(): Promise<void>;
  openTabletSettings(): void;
}

declare global {
  interface Window {
    BookBanditNative?: BookBanditNative;
  }
}

export function nativeApp(): BookBanditNative | null {
  return typeof window !== "undefined" ? (window.BookBanditNative ?? null) : null;
}
