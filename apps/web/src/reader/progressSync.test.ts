import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgressUpdate } from "@bookbandit/shared";
import type { ProgressRecord } from "../api/types";
import {
  defaultDeviceName,
  flushAllPending,
  locatorPercent,
  ProgressSync,
  resolveStartPosition,
  type KeyValueStore,
  type ProgressApi,
} from "./progressSync";

class MemoryStore implements KeyValueStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
}

function fakeApi(server: ProgressRecord | null = null) {
  const sent: ProgressUpdate[] = [];
  let fail = false;
  const api: ProgressApi = {
    getProgress: async () => server,
    putProgress: async (u) => {
      if (fail) throw new Error("offline");
      sent.push(u);
    },
  };
  return { api, sent, setFail: (v: boolean) => (fail = v) };
}

const epub = (percent: number) => ({ kind: "epub" as const, cfi: `epubcfi(/6/${Math.round(percent * 100)})`, percent });

describe("ProgressSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces page turns into one save", async () => {
    const { api, sent } = fakeApi();
    const store = new MemoryStore();
    const sync = new ProgressSync(api, "b1", { deviceName: "Tablet", store, debounceMs: 1000 });
    sync.report(epub(0.1));
    sync.report(epub(0.2));
    sync.report(epub(0.3));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(1);
    expect(sent[0].locator).toEqual(epub(0.3));
    expect(sent[0].deviceName).toBe("Tablet");
    expect(store.length).toBe(0);
  });

  it("keeps the position on this device when offline, then sends it later", async () => {
    const { api, sent, setFail } = fakeApi();
    const store = new MemoryStore();
    const sync = new ProgressSync(api, "b1", { deviceName: "Tablet", store, debounceMs: 10 });
    setFail(true);
    sync.report(epub(0.5));
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toHaveLength(0);
    expect(store.length).toBe(1);

    setFail(false);
    expect(await flushAllPending(api, store)).toBe(1);
    expect(sent[0].locator).toEqual(epub(0.5));
    expect(store.length).toBe(0);
  });

  it("flush sends right away (used when the tab is hidden)", async () => {
    const { api, sent } = fakeApi();
    const sync = new ProgressSync(api, "b1", { deviceName: "Web", store: new MemoryStore(), debounceMs: 60_000 });
    sync.report(epub(0.9), true);
    await sync.flush({ keepalive: true });
    expect(sent[0].finished).toBe(true);
  });
});

describe("resolveStartPosition", () => {
  const server: ProgressRecord = {
    bookId: "b1",
    locator: epub(0.4),
    percent: 0.4,
    finished: false,
    deviceName: "Phone",
    updatedAt: "2026-11-10T10:00:00Z",
  };

  it("uses the server position when nothing is pending here", async () => {
    const r = await resolveStartPosition(fakeApi(server).api, new MemoryStore(), "b1");
    expect(r?.locator).toEqual(epub(0.4));
    expect(r?.fromDevice).toBe("Phone");
  });

  it("prefers a newer unsent position from this device", async () => {
    const store = new MemoryStore();
    const local: ProgressUpdate = { bookId: "b1", locator: epub(0.6), updatedAt: "2026-11-11T10:00:00Z", deviceName: "Tablet" };
    store.setItem("bb-progress-pending:b1", JSON.stringify(local));
    const r = await resolveStartPosition(fakeApi(server).api, store, "b1");
    expect(r?.locator).toEqual(epub(0.6));
  });

  it("prefers the server when it is newer than the local copy", async () => {
    const store = new MemoryStore();
    const local: ProgressUpdate = { bookId: "b1", locator: epub(0.1), updatedAt: "2026-11-01T10:00:00Z", deviceName: "Tablet" };
    store.setItem("bb-progress-pending:b1", JSON.stringify(local));
    const r = await resolveStartPosition(fakeApi(server).api, store, "b1");
    expect(r?.locator).toEqual(epub(0.4));
  });

  it("returns null for a new book", async () => {
    expect(await resolveStartPosition(fakeApi(null).api, new MemoryStore(), "b1")).toBeNull();
  });
});

describe("helpers", () => {
  it("computes percent for each locator kind", () => {
    expect(locatorPercent({ kind: "page", page: 5, totalPages: 10 })).toBe(0.5);
    expect(locatorPercent({ kind: "audio", seconds: 30, durationSeconds: 0 })).toBe(0);
  });
  it("names devices", () => {
    expect(defaultDeviceName("Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit Chrome/120 Safari/537")).toBe(
      "Android tablet",
    );
    expect(defaultDeviceName("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36")).toBe("Web (Chrome)");
  });
});
