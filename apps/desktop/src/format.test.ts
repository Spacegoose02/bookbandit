import { describe, expect, it } from "vitest";
import { esc, mimeFor, percentLabel, sizeLabel, splitPairLink } from "./format";

describe("format helpers", () => {
  it("labels reading progress", () => {
    expect(percentLabel(null)).toBe("Not started");
    expect(percentLabel(0.004)).toBe("1%");
    expect(percentLabel(0.42)).toBe("42%");
    expect(percentLabel(0.995)).toBe("Finished");
  });

  it("labels sizes", () => {
    expect(sizeLabel(2048)).toBe("2 KB");
    expect(sizeLabel(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("splits a pasted pairing link into server and code", () => {
    expect(splitPairLink("bookbandit://pair?server=https%3A%2F%2Fbooks.example.com&code=ABCD-1234")).toEqual({
      address: "https://books.example.com",
      code: "ABCD-1234",
    });
    expect(splitPairLink(" nas:8080 ")).toEqual({ address: "nas:8080", code: null });
  });

  it("knows book types and escapes text", () => {
    expect(mimeFor("epub")).toBe("application/epub+zip");
    expect(mimeFor("cbr")).toBe("application/octet-stream");
    expect(esc(`<b>"Tom's"</b>`)).toBe("&lt;b&gt;&quot;Tom&#39;s&quot;&lt;/b&gt;");
  });
});
