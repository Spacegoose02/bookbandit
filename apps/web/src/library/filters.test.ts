import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  ageGroupOptions,
  EMPTY_FILTERS,
  filtersFromSearch,
  filtersToApiQuery,
  filtersToSearch,
} from "./filters";

describe("filtersFromSearch", () => {
  it("reads a full set of filters", () => {
    const f = filtersFromSearch(
      new URLSearchParams("q=dragon&author=Tolkien&yearFrom=1950&yearTo=1960&ratings=kids,teen&shelf=s1&sort=year"),
    );
    expect(f).toEqual({
      q: "dragon",
      author: "Tolkien",
      yearFrom: 1950,
      yearTo: 1960,
      ratings: ["kids", "teen"],
      shelf: "s1",
      sort: "year",
    });
  });

  it("swaps a backwards year range", () => {
    const f = filtersFromSearch(new URLSearchParams("yearFrom=2000&yearTo=1990"));
    expect([f.yearFrom, f.yearTo]).toEqual([1990, 2000]);
  });

  it("drops junk years, ratings and sort", () => {
    const f = filtersFromSearch(new URLSearchParams("yearFrom=abc&yearTo=12.5&ratings=kids,bogus,kids&sort=evil"));
    expect(f.yearFrom).toBeNull();
    expect(f.yearTo).toBeNull();
    expect(f.ratings).toEqual(["kids"]);
    expect(f.sort).toBe("title");
  });
});

describe("filtersToSearch", () => {
  it("round-trips", () => {
    const f = { ...EMPTY_FILTERS, author: "Le Guin", yearFrom: 1968, ratings: ["teen" as const] };
    expect(filtersFromSearch(filtersToSearch(f))).toEqual(f);
  });
  it("leaves defaults out", () => {
    expect(filtersToSearch(EMPTY_FILTERS).toString()).toBe("");
  });
});

describe("filtersToApiQuery", () => {
  it("never asks for ratings above the reader's limit", () => {
    const f = { ...EMPTY_FILTERS, ratings: ["kids" as const, "adult" as const] };
    const p = filtersToApiQuery(f, "middle_grade", { limit: 50, offset: 0 });
    expect(p.get("ratings")).toBe("kids");
    expect(p.get("limit")).toBe("50");
  });
});

describe("ageGroupOptions", () => {
  it("offers only groups up to the limit", () => {
    expect(ageGroupOptions("middle_grade")).toEqual(["kids", "middle_grade"]);
  });
});

describe("activeFilterCount", () => {
  it("counts a year range once", () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, yearFrom: 1, yearTo: 2, q: "x" })).toBe(2);
  });
});
