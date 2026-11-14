import { describe, expect, it } from "vitest";
import { nextInSameFile, splitHref } from "./extract";

describe("recipe hrefs", () => {
  it("split into file and fragment", () => {
    expect(splitHref("ch03.xhtml#pan%20cakes")).toEqual({ path: "ch03.xhtml", id: "pan cakes" });
    expect(splitHref("ch03.xhtml")).toEqual({ path: "ch03.xhtml", id: null });
  });

  it("end at the next recipe in the same file, or the end of the file", () => {
    const hrefs = ["ch03.xhtml", "ch03.xhtml#a", "ch03.xhtml#b", "ch04.xhtml#c"];
    expect(nextInSameFile(hrefs, "ch03.xhtml#a")).toBe("ch03.xhtml#b");
    expect(nextInSameFile(hrefs, "ch03.xhtml#b")).toBeNull();
    expect(nextInSameFile(hrefs, "ch03.xhtml")).toBe("ch03.xhtml#a");
    expect(nextInSameFile(hrefs, "ch04.xhtml#c")).toBeNull();
  });
});
