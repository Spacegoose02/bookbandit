import { describe, expect, it } from "vitest";
import { isNewerProgress, locatorPercent } from "./progress.js";

describe("locatorPercent", () => {
  it("reads each locator kind as a 0 to 1 fraction", () => {
    expect(locatorPercent({ kind: "epub", cfi: "epubcfi(/6/4)", percent: 0.25 })).toBe(0.25);
    expect(locatorPercent({ kind: "page", page: 30, totalPages: 120 })).toBe(0.25);
    expect(locatorPercent({ kind: "audio", seconds: 900, durationSeconds: 3600 })).toBe(0.25);
  });

  it("clamps out-of-range and empty books", () => {
    expect(locatorPercent({ kind: "epub", cfi: "x", percent: 1.4 })).toBe(1);
    expect(locatorPercent({ kind: "page", page: 3, totalPages: 0 })).toBe(0);
  });
});

describe("isNewerProgress", () => {
  it("prefers the later client time", () => {
    expect(isNewerProgress({ updatedAt: "2026-01-01T00:00:00Z" }, { updatedAt: "2026-01-02T00:00:00Z" })).toBe(true);
    expect(isNewerProgress({ updatedAt: "2026-01-02T00:00:00Z" }, { updatedAt: "2026-01-01T00:00:00Z" })).toBe(false);
  });
});
