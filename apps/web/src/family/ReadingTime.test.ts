import { describe, expect, it } from "vitest";
import { formatMinutes } from "./ReadingTime";

describe("formatMinutes", () => {
  it("rounds to minutes and switches to hours", () => {
    expect(formatMinutes(0)).toBe("0 min");
    expect(formatMinutes(29)).toBe("0 min");
    expect(formatMinutes(12 * 60)).toBe("12 min");
    expect(formatMinutes(60 * 60)).toBe("1 h");
    expect(formatMinutes(65 * 60)).toBe("1 h 5 min");
  });
});
