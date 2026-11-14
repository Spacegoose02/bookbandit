import { describe, expect, it } from "vitest";
import { allowedRatings, canSee, maxAllowedRating } from "./ratings.js";

const today = new Date("2026-11-14T00:00:00Z");
const kid = (birthYear: number | null) => ({ birthYear, isKid: true, explicitOptIn: false });

describe("maxAllowedRating", () => {
  it("limits young kids to kids books", () => {
    expect(maxAllowedRating(kid(2019), today)).toBe("kids"); // 6
  });
  it("opens middle grade at 8", () => {
    expect(maxAllowedRating(kid(2017), today)).toBe("middle_grade"); // 8
  });
  it("opens teen at 13", () => {
    expect(maxAllowedRating(kid(2012), today)).toBe("teen"); // 13
  });
  it("never gives a kid explicit, even if opt-in is somehow set", () => {
    expect(maxAllowedRating({ birthYear: 2000, isKid: true, explicitOptIn: true }, today)).toBe("adult");
  });
  it("treats a kid with no birth year as the youngest", () => {
    expect(maxAllowedRating(kid(null), today)).toBe("kids");
  });
  it("hides explicit from adults until they opt in", () => {
    expect(maxAllowedRating({ birthYear: null, isKid: false, explicitOptIn: false }, today)).toBe("adult");
    expect(maxAllowedRating({ birthYear: null, isKid: false, explicitOptIn: true }, today)).toBe("explicit");
  });
});

describe("canSee", () => {
  it("treats unrated books as adult", () => {
    expect(canSee(kid(2012), null, today)).toBe(false);
    expect(canSee({ birthYear: null, isKid: false, explicitOptIn: false }, null, today)).toBe(true);
  });
  it("blocks explicit for a teen", () => {
    expect(canSee(kid(2010), "explicit", today)).toBe(false);
  });
});

describe("allowedRatings", () => {
  it("lists ratings up to the max", () => {
    expect(allowedRatings(kid(2017), today)).toEqual(["kids", "middle_grade"]);
  });
});
