import { describe, expect, it } from "vitest";
import { addDays, bedtimeStatus, BADGES, DEFAULT_BEDTIME, formatMinute, localTime, longestRun, stickerEmoji } from "./rewards.js";

const school = { ...DEFAULT_BEDTIME, enabled: true, startMinute: 20 * 60, endMinute: 7 * 60, timeZone: "America/Chicago" };

describe("bedtimeStatus", () => {
  it("is off when disabled", () => {
    expect(bedtimeStatus(DEFAULT_BEDTIME, Date.parse("2026-11-14T05:00:00Z")).active).toBe(false);
  });

  it("is bedtime from the start time until the morning, in the kid's time zone", () => {
    // Wed 2026-11-11 20:30 Chicago = 02:30 UTC on the 12th
    const evening = bedtimeStatus(school, Date.parse("2026-11-12T02:30:00Z"));
    expect(evening.active).toBe(true);
    // Opens again at 07:00 Chicago = 13:00 UTC
    expect(evening.endsAt).toBe(Date.parse("2026-11-12T13:00:00Z"));
    // 06:59 the next morning is still bedtime, 07:00 isn't.
    expect(bedtimeStatus(school, Date.parse("2026-11-12T12:59:00Z")).active).toBe(true);
    expect(bedtimeStatus(school, Date.parse("2026-11-12T13:00:00Z")).active).toBe(false);
    // Afternoon: not bedtime.
    expect(bedtimeStatus(school, Date.parse("2026-11-12T21:00:00Z")).active).toBe(false);
  });

  it("warns when bedtime is less than an hour away", () => {
    // 19:20 Chicago
    expect(bedtimeStatus(school, Date.parse("2026-11-12T01:20:00Z")).startsInMinutes).toBe(40);
    expect(bedtimeStatus(school, Date.parse("2026-11-11T22:00:00Z")).startsInMinutes).toBeNull();
  });

  it("uses the weekend bedtime on Friday and Saturday nights", () => {
    const s = { ...school, weekendStartMinute: 21 * 60 + 30 };
    // Fri 2026-11-13 20:45 Chicago = 02:45 UTC Sat
    expect(bedtimeStatus(s, Date.parse("2026-11-14T02:45:00Z")).active).toBe(false);
    // Thu 20:45: school night
    expect(bedtimeStatus(s, Date.parse("2026-11-13T02:45:00Z")).active).toBe(true);
    // Fri 21:30
    expect(bedtimeStatus(s, Date.parse("2026-11-14T03:30:00Z")).active).toBe(true);
  });
});

describe("helpers", () => {
  it("reads local wall-clock time", () => {
    const t = localTime(Date.parse("2026-11-14T03:15:00Z"), "America/Chicago");
    expect(t).toEqual({ date: "2026-11-13", month: "2026-11", minute: 21 * 60 + 15, weekday: 5 });
    expect(localTime(0, "Not/AZone").date).toBe("1970-01-01");
  });

  it("does date math and runs", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(longestRun(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-05"])).toBe(3);
    expect(longestRun([])).toBe(0);
  });

  it("formats times and keeps stickers stable", () => {
    expect(formatMinute(20 * 60 + 5)).toBe("8:05 pm");
    expect(formatMinute(0)).toBe("12:00 am");
    expect(stickerEmoji("book", "abc")).toBe(stickerEmoji("book", "abc"));
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(BADGES.length);
  });
});
