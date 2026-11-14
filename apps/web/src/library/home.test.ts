import { describe, expect, it } from "vitest";
import type { BookSummary, Shelf } from "../api/types";
import { deskItems, extraShelves, genreRowCandidates, greeting, jumpBackIn, seriesToContinue, splitByAudience, timeLeft } from "./home";

const book = (id: string, percent: number | null = null): BookSummary => ({
  id,
  title: `Book ${id}`,
  publishedYear: null,
  rating: "kids",
  coverPath: null,
  kindleOnly: false,
  percent,
});

describe("greeting", () => {
  it("follows the clock", () => {
    expect(greeting(3)).toBe("Up late");
    expect(greeting(9)).toBe("Good morning");
    expect(greeting(14)).toBe("Good afternoon");
    expect(greeting(20)).toBe("Good evening");
  });
});

describe("jumpBackIn", () => {
  it("puts reading first, adds listen-only books, and merges a book in both", () => {
    const items = jumpBackIn(
      [book("a", 0.2), book("b", 0.5)],
      [
        { id: "b", title: "Book b", coverPath: null, progress: { percent: 0.7, currentTime: 700, duration: 1000 } },
        { id: "c", title: "Book c", coverPath: null, progress: { percent: 0.1, currentTime: 60, duration: 600 } },
      ],
    );
    expect(items.map((i) => i.book.id)).toEqual(["a", "b", "c"]);
    expect(items[1]).toMatchObject({ reading: true, listening: true, percent: 0.7, secondsLeft: 300 });
    expect(items[2]).toMatchObject({ reading: false, listening: true, secondsLeft: 540 });
  });

  it("caps the list", () => {
    expect(jumpBackIn([book("a"), book("b"), book("c")], [], 2)).toHaveLength(2);
  });
});

describe("timeLeft", () => {
  it("reads naturally", () => {
    expect(timeLeft(20)).toBe("under a minute left");
    expect(timeLeft(25 * 60)).toBe("25 min left");
    expect(timeLeft(2 * 3600)).toBe("2 h left");
    expect(timeLeft(3600 + 5 * 60)).toBe("1 h 5 min left");
  });
});

describe("seriesToContinue", () => {
  const shelf = (id: string, books: BookSummary[], kind: Shelf["kind"] = "series"): Shelf => ({ id, name: id, kind, books, total: books.length });

  it("lists only started series with more than one book, pointing at the book in progress", () => {
    const picks = seriesToContinue(
      [
        shelf("series:new", [book("n1"), book("n2")]),
        shelf("series:mine", [book("m1", 1), book("m2", 0.4), book("m3")]),
        shelf("series:imprint", [book("i1", 0.5)]),
      ],
      new Set(["m2", "i1"]),
    );
    expect(picks.map((p) => p.id)).toEqual(["mine"]);
    expect(picks[0]).toMatchObject({ started: true, next: { id: "m2" } });
  });

  it("moves on to the next unread book after finishing one", () => {
    const picks = seriesToContinue([shelf("series:s", [book("s1", 1), book("s2")])], new Set());
    expect(picks[0].next?.id).toBe("s2");
  });

  it("ignores shelves that aren't series", () => {
    expect(seriesToContinue([shelf("recent", [book("a", 0.5), book("b")], "recent")], new Set(["a"]))).toEqual([]);
  });
});

describe("extraShelves", () => {
  it("keeps collections, and sections with enough books for a row", () => {
    const four = [book("a"), book("b"), book("c"), book("d")];
    const shelves: Shelf[] = [
      { id: "continue", name: "c", kind: "continue", books: four },
      { id: "recent", name: "r", kind: "recent", books: four },
      { id: "tag:big", name: "Cookbooks", kind: "tag", books: four },
      { id: "tag:small", name: "Tiny", kind: "tag", books: [book("a")] },
      { id: "collection:y", name: "Bedtime", kind: "collection", books: [book("a")] },
      { id: "collection:z", name: "Empty", kind: "collection", books: [] },
    ];
    expect(extraShelves(shelves).map((s) => s.id)).toEqual(["tag:big", "collection:y"]);
  });
});

describe("splitByAudience", () => {
  it("keeps kids' books apart and counts unrated as grown-up", () => {
    const r = (id: string, rating: BookSummary["rating"]) => ({ ...book(id), rating });
    const { grownUp, kids } = splitByAudience([r("a", "kids"), r("b", "adult"), r("c", null), r("d", "middle_grade"), r("e", "teen")]);
    expect(grownUp.map((b) => b.id)).toEqual(["b", "c", "e"]);
    expect(kids.map((b) => b.id)).toEqual(["a", "d"]);
  });
});

describe("genreRowCandidates", () => {
  const cat = (id: string, bookCount: number, ratings: BookSummary["rating"][] = ["adult"], kind = "genre") => ({
    id,
    kind,
    bookCount,
    books: ratings.map((rating, i) => ({ ...book(`${id}${i}`), rating })),
  });
  it("picks the biggest grown-up genres with enough books", () => {
    const picks = genreRowCandidates([
      cat("fantasy", 40),
      cat("tiny", 2),
      cat("picture", 90, ["kids", "kids", "adult"]),
      cat("kids-section", 99, ["adult"], "section"),
      cat("romance", 120),
      cat("mystery", 12),
    ], 2);
    expect(picks.map((c) => c.id)).toEqual(["romance", "fantasy"]);
  });
});

describe("deskItems", () => {
  const overview = { inbox: 4, unrated: 0, pendingRequests: 2 };
  it("gives admins the inbox, approvals and the family link, skipping zeros", () => {
    expect(deskItems("admin", overview, { open: 0, toApprove: 2 }).map((i) => i.to)).toEqual(["/admin/inbox", "/requests", "/family"]);
  });
  it("gives parents approvals and the family link, never admin queues", () => {
    expect(deskItems("parent", null, { open: 0, toApprove: 1 }).map((i) => i.label)).toEqual(["request to approve", "See how the kids are reading"]);
  });
  it("shows other grown-ups only their own open requests", () => {
    expect(deskItems("adult", null, { open: 3, toApprove: 0 })).toEqual([{ to: "/requests", label: "open requests", count: 3, icon: "🙋" }]);
    expect(deskItems("adult", null, { open: 0, toApprove: 0 })).toEqual([]);
  });
});
