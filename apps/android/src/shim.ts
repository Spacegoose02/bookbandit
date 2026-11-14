/**
 * Loaded at the top of the web app's index.html inside the tablet app (scripts/assemble-www.mjs
 * adds it). It sends unpaired tablets to the pairing screen, routes /api requests that have a body
 * through the native layer, and gives the web app `window.BookBanditNative` for offline downloads,
 * screen pinning and the tablet settings screen (apps/web/src/native/ uses it when present).
 */
import { Capacitor } from "@capacitor/core";
import { BookBandit, type DownloadEvent, type DownloadStatus } from "./native";
import { makeFetch } from "./fetchShim";

export interface BookBanditNativeApi {
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
    BookBanditNative?: BookBanditNativeApi;
  }
}

const SETUP = "/native/setup.html";

function boot() {
  const state = window.__BB_NATIVE__;
  const onNativePage = location.pathname.startsWith("/native/");

  if (state && !state.paired && !onNativePage) {
    location.replace(SETUP);
    return;
  }
  if (!state) {
    // state.js wasn't answered natively (shouldn't happen); ask the plugin instead.
    void BookBandit.getState().then((s) => {
      if (!s.paired && !onNativePage) location.replace(SETUP);
    });
  }

  try {
    if (state?.deviceName) localStorage.setItem("bb-device-name", state.deviceName);
  } catch {
    /* ignore */
  }

  // In a desktop-browser preview there is no native layer, and the page's own origin serves /api.
  if (Capacitor.isNativePlatform()) {
    window.fetch = makeFetch(window.fetch.bind(window), (req) => BookBandit.request(req), location.origin);
  }

  window.BookBanditNative = {
    platform: "android",
    appVersion: state?.appVersion ?? "",
    deviceName: state?.deviceName ?? "Tablet",
    async download(bookId, fileId) {
      await BookBandit.download({ bookId, fileId });
    },
    async removeDownload(bookId) {
      await BookBandit.removeDownload({ bookId });
    },
    async downloadStatus(bookId) {
      return (await BookBandit.downloadStatus({ bookId })).status;
    },
    onDownload(cb) {
      const handle = BookBandit.addListener("download", cb);
      return () => void handle.then((h) => h.remove());
    },
    pinScreen: () => BookBandit.pinScreen(),
    openTabletSettings() {
      location.href = "/native/settings.html";
    },
  };
}

boot();
