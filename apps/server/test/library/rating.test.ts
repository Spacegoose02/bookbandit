import { describe, expect, it } from "vitest";
import { autoRating, shouldReplaceRating } from "../../src/metadata/rating.js";

describe("automatic ratings", () => {
  it("uses rating folders", () => {
    expect(autoRating({ relPaths: ["adult/x.epub"], metadata: {} })).toMatchObject({ rating: "adult", source: "folder" });
    expect(autoRating({ relPaths: ["Kids/Mo Willems/x.epub"], metadata: {} })).toMatchObject({ rating: "kids", source: "folder" });
    expect(autoRating({ relPaths: ["Erotica/x.epub"], metadata: {} })).toMatchObject({ rating: "explicit" });
  });

  it("leaves books with no signal unrated (treated as adult)", () => {
    expect(autoRating({ relPaths: ["Some Author/x.epub"], metadata: { subjects: ["Fantasy"] } })).toBeNull();
  });

  it("treats Google's mature flag as at least adult", () => {
    expect(autoRating({ relPaths: ["x.epub"], metadata: {}, maturity: "MATURE" })).toMatchObject({ rating: "adult", source: "metadata" });
    expect(autoRating({ relPaths: ["x.epub"], metadata: {}, maturity: "NOT_MATURE" })).toBeNull();
  });

  it("rates erotica genres explicit", () => {
    expect(autoRating({ relPaths: ["x.epub"], metadata: { subjects: ["Fiction / Romance / Erotica"] } })?.rating).toBe("explicit");
    expect(autoRating({ relPaths: ["x.epub"], metadata: { contentWarnings: ["Sexual content"] } })?.rating).toBe("adult");
  });

  it("recognises children's and YA genres", () => {
    expect(autoRating({ relPaths: ["x.epub"], metadata: { subjects: ["Picture books"] } })?.rating).toBe("kids");
    expect(autoRating({ relPaths: ["x.epub"], metadata: { subjects: ["Juvenile Fiction"] } })?.rating).toBe("middle_grade");
    expect(autoRating({ relPaths: ["x.epub"], metadata: { subjects: ["Young Adult Fiction"] } })?.rating).toBe("teen");
  });

  it("lets the most restrictive signal win, so a kids folder can't hide erotica", () => {
    const r = autoRating({ relPaths: ["kids/x.epub"], metadata: { subjects: ["Erotica"] } });
    expect(r?.rating).toBe("explicit");
    expect(autoRating({ relPaths: ["kids/x.epub"], metadata: {}, maturity: "MATURE" })?.rating).toBe("adult");
  });

  it("maps ComicInfo age ratings", () => {
    expect(autoRating({ relPaths: ["x.cbz"], metadata: { ageRating: "Adults Only 18+" } })?.rating).toBe("explicit");
    expect(autoRating({ relPaths: ["x.cbz"], metadata: { ageRating: "Everyone" } })?.rating).toBe("kids");
  });
});

describe("replacing ratings", () => {
  const kids = { rating: "kids" as const, source: "keywords" as const, reason: "" };
  const explicit = { rating: "explicit" as const, source: "keywords" as const, reason: "" };

  it("never replaces an admin rating", () => {
    expect(shouldReplaceRating({ rating: "teen", ratingSource: "admin", approved: true }, explicit)).toBe(false);
    expect(shouldReplaceRating({ rating: "teen", ratingSource: "admin", approved: false }, kids)).toBe(false);
  });

  it("only raises approved books, counting unrated as adult", () => {
    expect(shouldReplaceRating({ rating: null, ratingSource: null, approved: true }, kids)).toBe(false);
    expect(shouldReplaceRating({ rating: "teen", ratingSource: "keywords", approved: true }, kids)).toBe(false);
    expect(shouldReplaceRating({ rating: null, ratingSource: null, approved: true }, explicit)).toBe(true);
  });

  it("takes the fresh rating for inbox books", () => {
    expect(shouldReplaceRating({ rating: null, ratingSource: null, approved: false }, kids)).toBe(true);
  });
});
