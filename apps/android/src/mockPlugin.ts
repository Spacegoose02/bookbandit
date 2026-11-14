import { WebPlugin } from "@capacitor/core";
import type { BookBanditPlugin, DownloadedBook, DownloadEvent, NativeRequest, NativeResponse, NativeState } from "./native";

/**
 * Stand-in for the Java plugin when the pages run in a plain browser (`pnpm preview`, screenshots).
 * Never used in the APK, where Capacitor routes calls to BookBanditPlugin.java.
 */
export class MockBookBandit extends WebPlugin implements BookBanditPlugin {
  private paired = new URLSearchParams(location.search).has("paired");
  private pin = "1234";
  private autoPin = true;
  private books: DownloadedBook[] = [
    { bookId: "b1", fileId: "f1", title: "The Lighthouse Keeper's Cat", format: "epub", sizeBytes: 1_830_000, downloadedAt: Date.now() - 86_400_000 },
    { bookId: "b2", fileId: "f2", title: "Moonlight Robots", format: "epub", sizeBytes: 3_420_000, downloadedAt: Date.now() - 3_600_000 },
    { bookId: "b3", fileId: "f3", title: "Dinosaur Detectives, Volume 1", format: "cbz", sizeBytes: 48_200_000, downloadedAt: Date.now() - 600_000 },
  ];

  async getState(): Promise<NativeState> {
    return {
      paired: this.paired,
      server: this.paired ? "http://192.168.1.20:8080" : null,
      deviceName: "Ada's Fire tablet",
      deviceId: "d1",
      lockedToPerson: false,
      hasPin: true,
      autoPinKids: this.autoPin,
      pinned: false,
      appVersion: "0.2.0",
      pendingPairLink: null,
      userId: "u1",
      role: "kid",
    };
  }

  async pair(o: { server: string; code: string; name: string }) {
    if (o.code.replace(/\W/g, "").length !== 8) throw { code: "PAIR_FAILED", message: "That code didn't work. Ask a grown-up for a new one." };
    this.paired = true;
    return { deviceName: o.name, lockedToPerson: false };
  }

  async unpair() {
    this.paired = false;
  }

  async request(o: NativeRequest): Promise<NativeResponse> {
    const res = await fetch(o.path, { method: o.method, headers: o.headers, body: o.body });
    return { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "" }, body: await res.text() };
  }

  async download(o: { bookId: string }): Promise<DownloadEvent> {
    return { status: "queued", bookId: o.bookId, received: 0, total: 0 };
  }

  async removeDownload(o: { bookId: string }) {
    this.books = this.books.filter((b) => b.bookId !== o.bookId);
  }

  async listDownloads() {
    return { items: this.books, usedBytes: this.books.reduce((n, b) => n + b.sizeBytes, 0), freeBytes: 21_400_000_000 };
  }

  async downloadStatus(o: { bookId: string }): Promise<DownloadEvent> {
    return { status: this.books.some((b) => b.bookId === o.bookId) ? "done" : "none", bookId: o.bookId, received: 0, total: 0 };
  }

  async pinScreen() {}

  async unpinScreen(o: { pin?: string }) {
    return this.checkPin(o);
  }

  async checkPin(o: { pin?: string }) {
    if (o.pin !== this.pin) throw { code: "WRONG_PIN", message: "That PIN isn't right", data: { retryAfterMs: 0 } };
  }

  async setPin(o: { oldPin?: string; newPin: string }) {
    await this.checkPin({ pin: o.oldPin });
    this.pin = o.newPin;
  }

  async setAutoPinKids(o: { value: boolean; pin?: string }) {
    await this.checkPin({ pin: o.pin });
    this.autoPin = o.value;
  }
}
