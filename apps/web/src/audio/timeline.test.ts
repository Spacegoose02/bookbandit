import { describe, expect, it } from "vitest";
import { chapterAt, formatTime, locate, sleepState, totalDuration } from "./timeline";

const tracks = [
  { startOffset: 0, duration: 100 },
  { startOffset: 100, duration: 50 },
  { startOffset: 150, duration: 200 },
];

describe("locate", () => {
  it("maps book time to a track and offset", () => {
    expect(locate(tracks, 0)).toEqual({ index: 0, offset: 0 });
    expect(locate(tracks, 99.5)).toEqual({ index: 0, offset: 99.5 });
    expect(locate(tracks, 100)).toEqual({ index: 1, offset: 0 });
    expect(locate(tracks, 170)).toEqual({ index: 2, offset: 20 });
  });
  it("clamps out-of-range times", () => {
    expect(locate(tracks, -5)).toEqual({ index: 0, offset: 0 });
    expect(locate(tracks, 9999)).toEqual({ index: 2, offset: 200 });
    expect(locate([], 10)).toEqual({ index: 0, offset: 0 });
    expect(totalDuration(tracks)).toBe(350);
  });
});

describe("chapters and time", () => {
  it("finds the chapter at a time", () => {
    const ch = [
      { start: 0, end: 60, title: "One" },
      { start: 60, end: 120, title: "Two" },
    ];
    expect(chapterAt(ch, 30)).toBe(0);
    expect(chapterAt(ch, 60)).toBe(1);
    expect(chapterAt([], 60)).toBe(-1);
  });
  it("formats times", () => {
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(3723)).toBe("1:02:03");
    expect(formatTime(-3)).toBe("0:00");
  });
});

describe("sleep timer", () => {
  it("fades out over the last ten seconds, then stops", () => {
    const t = { kind: "minutes" as const, minutes: 15, endsAt: 100_000 };
    expect(sleepState(t, 50_000, 0)).toEqual({ volume: 1, stop: false });
    expect(sleepState(t, 95_000, 0).volume).toBeCloseTo(0.5);
    expect(sleepState(t, 100_000, 0)).toEqual({ volume: 0, stop: true });
  });
  it("can stop at the end of the chapter, faster at higher speed", () => {
    const t = { kind: "chapter" as const, chapterEnd: 120 };
    expect(sleepState(t, 0, 100)).toEqual({ volume: 1, stop: false });
    expect(sleepState(t, 0, 115, 2).volume).toBeCloseTo(0.25);
    expect(sleepState(t, 0, 120).stop).toBe(true);
    expect(sleepState({ kind: "off" }, 0, 0)).toEqual({ volume: 1, stop: false });
  });
});
