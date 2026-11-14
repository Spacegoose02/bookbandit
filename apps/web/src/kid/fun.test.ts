import { describe, expect, it } from "vitest";
import type { RewardSticker } from "@bookbandit/shared";
import type { BookSummary } from "../api/types";
import { choosable, shuffleDelays } from "./BookSpinner";
import { gardenPlots } from "./Garden";

const book = (id: string, percent: number | null, kindleOnly = false) => ({ id, title: id, percent, kindleOnly }) as unknown as BookSummary;

describe("pick a book for me", () => {
  it("offers unfinished books, never Kindle-only ones", () => {
    const pool = choosable([book("a", 1), book("b", 0.3), book("c", null), book("k", 0, true)]);
    expect(pool.map((b) => b.id)).toEqual(["b", "c"]);
  });

  it("falls back to every readable book when nearly all are finished", () => {
    expect(choosable([book("a", 1), book("b", 1), book("c", 0.2)]).map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  it("slows down to a stop in about two seconds", () => {
    const d = shuffleDelays();
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]!);
    const total = d.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(1200);
    expect(total).toBeLessThan(2600);
  });
});

describe("reading garden", () => {
  const now = Date.parse("2026-11-14T15:00:00Z");
  const st = (reason: RewardSticker["reason"], key: string, earnedAt: number, title?: string): RewardSticker => ({
    id: `${reason}-${key}-${earnedAt}`,
    reason,
    key,
    emoji: "⭐",
    earnedAt,
    book: title ? { id: title, title, coverPath: null } : null,
  });

  it("plants a tulip for goal days and a sunflower for finished books, this month only", () => {
    const plots = gardenPlots(
      {
        goal: null,
        stickers: [
          st("goal_day", "2026-11-02", Date.parse("2026-11-02T20:00:00Z")),
          st("goal_day", "2026-10-30", Date.parse("2026-10-30T20:00:00Z")),
          st("book", "b1", Date.parse("2026-11-10T18:00:00Z"), "Dino Days"),
          st("goal_day", "2026-11-10", Date.parse("2026-11-10T19:00:00Z")),
        ],
      },
      now,
      "UTC",
    );
    expect(plots).toHaveLength(30);
    expect(plots[1]).toMatchObject({ date: "2026-11-02", plant: "tulip" });
    expect(plots[9]).toMatchObject({ plant: "sunflower", label: "Day 10: finished Dino Days" });
    expect(plots[13]!.plant).toBe("soil");
    expect(plots[14]!.plant).toBe("later");
    expect(plots.filter((p) => p.plant === "tulip" || p.plant === "sunflower")).toHaveLength(2);
  });

  it("never marks a missed day as anything worse than soil", () => {
    const plots = gardenPlots({ goal: null, stickers: [] }, now, "UTC");
    expect(new Set(plots.map((p) => p.plant))).toEqual(new Set(["soil", "later"]));
  });
});
