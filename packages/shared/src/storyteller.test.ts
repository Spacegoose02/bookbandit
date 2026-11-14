import { describe, expect, it } from "vitest";
import { isValidTimeZone, nightKey, tonightFrom } from "./storyteller.js";

describe("nightKey", () => {
  it("counts the small hours toward the evening before", () => {
    // 2026-11-14 03:00 in Chicago (UTC-6) is 09:00 UTC.
    expect(nightKey(new Date("2026-11-14T09:00:00Z"), "America/Chicago", 12)).toBe("2026-11-13");
    // 19:30 Chicago on the 14th
    expect(nightKey(new Date("2026-11-15T01:30:00Z"), "America/Chicago", 12)).toBe("2026-11-14");
  });

  it("starts a new night at the configured hour", () => {
    expect(nightKey(new Date("2026-11-14T11:59:00Z"), "UTC", 12)).toBe("2026-11-13");
    expect(nightKey(new Date("2026-11-14T12:00:00Z"), "UTC", 12)).toBe("2026-11-14");
    expect(nightKey(new Date("2026-03-01T05:00:00Z"), "UTC", 6)).toBe("2026-02-28");
  });

  it("falls back to UTC for a bad time zone", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(nightKey(new Date("2026-11-14T13:00:00Z"), "Not/AZone", 12)).toBe("2026-11-14");
  });
});

describe("tonightFrom", () => {
  it("reports goodnight when either limit is used up", () => {
    expect(tonightFrom("n", { storiesUsed: 2, secondsUsed: 100 }, { storiesPerNight: 2, minutesPerNight: null }).goodnight).toBe(true);
    expect(tonightFrom("n", { storiesUsed: 0, secondsUsed: 600 }, { storiesPerNight: null, minutesPerNight: 10 }).goodnight).toBe(true);
    const t = tonightFrom("n", { storiesUsed: 1, secondsUsed: 90 }, { storiesPerNight: 3, minutesPerNight: 10 });
    expect(t).toMatchObject({ storiesLeft: 2, secondsLeft: 510, goodnight: false });
    expect(tonightFrom("n", { storiesUsed: 9, secondsUsed: 9999 }, { storiesPerNight: null, minutesPerNight: null }).goodnight).toBe(false);
  });
});
