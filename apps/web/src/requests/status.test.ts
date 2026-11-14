import { describe, expect, it } from "vitest";
import { ago, isUploadable, percent, statusLabel } from "./status";

describe("request status labels", () => {
  it("speaks to kids in their own words", () => {
    expect(statusLabel({ status: "pending", book: null, waitingForReview: false }, true).text).toBe("Waiting for a grown-up");
    expect(statusLabel({ status: "pending", book: null, waitingForReview: false }).text).toBe("Waiting for approval");
  });

  it("only says ready when the reader can open the book", () => {
    const book = { id: "b1", title: "x", coverPath: null };
    expect(statusLabel({ status: "done", book, waitingForReview: false }, true)).toMatchObject({ text: "Ready to read!", tone: "done" });
    expect(statusLabel({ status: "done", book: null, waitingForReview: true }, true)).toMatchObject({ text: "Almost ready", tone: "busy" });
  });
});

describe("helpers", () => {
  it("formats percent and time", () => {
    expect(percent(0.554)).toBe("55%");
    expect(percent(null)).toBeNull();
    expect(ago(1_000_000 - 30_000, 1_000_000)).toBe("just now");
    expect(ago(1_000_000 - 3 * 3600_000, 1_000_000)).toBe("3 h ago");
  });

  it("knows which files can be uploaded", () => {
    expect(isUploadable("Dune.EPUB")).toBe(true);
    expect(isUploadable("comics.cbz")).toBe(true);
    expect(isUploadable("setup.exe")).toBe(false);
  });
});
