import { describe, expect, it } from "vitest";
import { toMe } from "./client";

const today = new Date("2026-11-14T00:00:00Z");
const base = { id: "u1", displayName: "Mia", avatar: null, theme: "dinosaur", birthYear: 2019, explicitOptIn: false };

describe("toMe", () => {
  it("works out a young kid's limit from their birth year", () => {
    const me = toMe({ ...base, role: "kid" }, today);
    expect(me.isKid).toBe(true);
    expect(me.maxRating).toBe("kids");
    expect(me.theme).toBe("dinosaur");
  });

  it("never gives a kid explicit, even if the flag is set", () => {
    expect(toMe({ ...base, role: "kid", birthYear: 2000, explicitOptIn: true }, today).maxRating).toBe("adult");
  });

  it("gives adults explicit only after opting in", () => {
    expect(toMe({ ...base, role: "adult", birthYear: null }, today).maxRating).toBe("adult");
    expect(toMe({ ...base, role: "parent", birthYear: null, explicitOptIn: true }, today).maxRating).toBe("explicit");
  });

  it("falls back to the default theme for unknown names", () => {
    expect(toMe({ ...base, role: "adult", theme: "sparkles" }, today).theme).toBe("dark");
  });
});
