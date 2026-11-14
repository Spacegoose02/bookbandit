import { describe, expect, it } from "vitest";
import { clampPage, fraction, pageLocator, startPage } from "./pdf";

describe("pdf positions", () => {
  it("clamps pages into range", () => {
    expect(clampPage(-3, 10)).toBe(0);
    expect(clampPage(12, 10)).toBe(9);
    expect(clampPage(4.7, 10)).toBe(4);
    expect(clampPage(3, 0)).toBe(0);
  });

  it("resumes from a saved page", () => {
    expect(startPage({ kind: "page", page: 41, totalPages: 120 }, 120)).toBe(41);
  });

  it("keeps the relative spot when the page count changed", () => {
    expect(startPage({ kind: "page", page: 50, totalPages: 100 }, 200)).toBe(100);
  });

  it("maps a percent from another format", () => {
    expect(startPage({ kind: "epub", cfi: "x", percent: 0.5 }, 11)).toBe(5);
    expect(startPage(null, 11)).toBe(0);
  });

  it("reports fraction and locator", () => {
    expect(fraction({ page: 9, total: 10 })).toBe(1);
    expect(fraction({ page: 0, total: 10 })).toBe(0);
    expect(pageLocator({ page: 3, total: 10 })).toEqual({ kind: "page", page: 3, totalPages: 10 });
  });
});
