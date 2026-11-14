import { describe, expect, it } from "vitest";
import { flattenRecipes } from "./recipes";

describe("flattenRecipes", () => {
  it("flattens nested contents, keeps depth and drops repeats", () => {
    const toc = [
      { label: "Soups", href: "soups.xhtml", subitems: [
        { label: "  Tomato   soup ", href: "soups.xhtml#tomato" },
        { label: "Leek soup", href: "soups.xhtml#leek" },
      ] },
      { label: "Soups again", href: "soups.xhtml" },
      { label: "", href: "blank.xhtml" },
    ];
    expect(flattenRecipes(toc)).toEqual([
      { label: "Soups", href: "soups.xhtml", depth: 0 },
      { label: "Tomato soup", href: "soups.xhtml#tomato", depth: 1 },
      { label: "Leek soup", href: "soups.xhtml#leek", depth: 1 },
    ]);
  });
});
