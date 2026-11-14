import { describe, expect, it } from "vitest";
import { moveItem, positionLabel } from "./order";

describe("moveItem", () => {
  it("moves down, up, and ignores bad indexes", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    const same = ["a"];
    expect(moveItem(same, 0, 3)).toBe(same);
  });
  it("labels positions", () => {
    expect(positionLabel(2)).toBe("Book 2");
    expect(positionLabel(1.5)).toBe("Book 1.5");
    expect(positionLabel(null)).toBe("");
  });
});
