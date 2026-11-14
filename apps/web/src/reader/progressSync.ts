import { isNewerProgress, type ProgressUpdate, type ReadingLocator } from "@bookbandit/shared";
import type { ProgressRecord } from "../api/types";

/** The parts of the API progress sync needs; lets tests pass a fake. */
export interface ProgressApi {
  getProgress(bookId: string): Promise<ProgressRecord | null>;
  putProgress(update: ProgressUpdate, opts?: { keepalive?: boolean }): Promise<void>;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

const PENDING_PREFIX = "bb-progress-pending:";
const pendingKey = (bookId: string) => PENDING_PREFIX + bookId;

export function locatorPercent(locator: ReadingLocator): number {
  switch (locator.kind) {
    case "epub":
      return locator.percent;
    case "page":
      return locator.totalPages > 0 ? locator.page / locator.totalPages : 0;
    case "audio":
      return locator.durationSeconds > 0 ? locator.seconds / locator.durationSeconds : 0;
  }
}

function readPending(store: KeyValueStore, bookId: string): ProgressUpdate | null {
  try {
    const raw = store.getItem(pendingKey(bookId));
    return raw ? (JSON.parse(raw) as ProgressUpdate) : null;
  } catch {
    return null;
  }
}

/**
 * Where to open a book: the newest of what the server has and what this device
 * saved but couldn't send yet (e.g. read offline on a tablet). Newest wins.
 */
export async function resolveStartPosition(
  api: ProgressApi,
  store: KeyValueStore,
  bookId: string,
): Promise<{ locator: ReadingLocator; fromDevice: string | null; updatedAt: string } | null> {
  const local = readPending(store, bookId);
  let server: ProgressRecord | null = null;
  try {
    server = await api.getProgress(bookId);
  } catch {
    // Offline: fall back to whatever this device has.
  }
  if (local && isNewerProgress(server, local)) {
    return { locator: local.locator, fromDevice: local.deviceName, updatedAt: local.updatedAt };
  }
  if (server) return { locator: server.locator, fromDevice: server.deviceName, updatedAt: server.updatedAt };
  return null;
}

export interface ProgressSyncOptions {
  deviceName: string;
  store: KeyValueStore;
  /** Wait this long after the last page turn before sending. */
  debounceMs?: number;
  now?: () => Date;
}

/**
 * Saves reading position for one open book.
 * Every page turn is written to local storage right away (so nothing is lost if the tab
 * closes or the tablet is offline) and sent to the server after a short pause.
 */
export class ProgressSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly debounceMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly api: ProgressApi,
    private readonly bookId: string,
    private readonly opts: ProgressSyncOptions,
  ) {
    this.debounceMs = opts.debounceMs ?? 2000;
    this.now = opts.now ?? (() => new Date());
  }

  report(locator: ReadingLocator, finished = false): void {
    const update: ProgressUpdate = {
      bookId: this.bookId,
      locator,
      updatedAt: this.now().toISOString(),
      deviceName: this.opts.deviceName,
      ...(finished ? { finished: true } : {}),
    };
    try {
      this.opts.store.setItem(pendingKey(this.bookId), JSON.stringify(update));
    } catch {
      /* storage full or blocked: still try the network */
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Send the newest unsent position now. Safe to call often. */
  async flush(opts?: { keepalive?: boolean }): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    const pending = readPending(this.opts.store, this.bookId);
    if (!pending) return true;
    this.inFlight = this.api.putProgress(pending, opts);
    try {
      await this.inFlight;
      // Only clear if nothing newer was written while we were sending.
      const latest = readPending(this.opts.store, this.bookId);
      if (latest?.updatedAt === pending.updatedAt) this.opts.store.removeItem(pendingKey(this.bookId));
      return true;
    } catch {
      return false;
    } finally {
      this.inFlight = null;
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** On start-up or when the network comes back, send positions saved while offline. */
export async function flushAllPending(api: ProgressApi, store: KeyValueStore): Promise<number> {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(PENDING_PREFIX)) keys.push(k);
  }
  let sent = 0;
  for (const k of keys) {
    const raw = store.getItem(k);
    if (!raw) continue;
    try {
      await api.putProgress(JSON.parse(raw) as ProgressUpdate);
      if (store.getItem(k) === raw) store.removeItem(k);
      sent++;
    } catch {
      /* try again later */
    }
  }
  return sent;
}

/** A readable name for this device, shown as "Last read on ..." elsewhere. */
export function defaultDeviceName(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  return `Web (${browser})`;
}
