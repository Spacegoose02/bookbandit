import { describe, expect, it } from "vitest";
import { classifySubjects, cleanSubjects, fictionSignal, subjectKey } from "../src/discover/taxonomy.js";

describe("category taxonomy", () => {
  it("treats case, plurals, & and punctuation as the same subject", () => {
    expect(subjectKey("Fairy tales")).toBe(subjectKey("fairy Tale"));
    expect(subjectKey("Sci-Fi")).toBe(subjectKey("sci fi"));
    expect(subjectKey("Comics & Graphic Novels")).toBe(subjectKey("comics and graphic novel"));
    expect(subjectKey("Stories")).toBe(subjectKey("story"));
    expect(subjectKey("Business")).not.toBe(subjectKey("Busines"));
  });

  it("maps Open Library style subjects onto a few curated categories", () => {
    // Harry Potter style: dozens of subjects become two categories.
    expect(
      classifySubjects([
        "Fiction",
        "Magic -- Fiction",
        "Wizards -- Fiction",
        "Hogwarts School of Witchcraft and Wizardry (Imaginary organization) -- Fiction",
        "England -- Fiction",
        "Schools -- Fiction",
        "Juvenile fiction",
        "Fantasy fiction",
        "Friendship -- Fiction",
      ]),
    ).toEqual(["Children's Books", "Fantasy", "Literary Fiction"]);
  });

  it("splits Google style paths and keeps nonfiction out of fiction books", () => {
    expect(classifySubjects(["Fiction", "Science Fiction", "Space Opera", "Robots"])).toEqual(["Science Fiction"]);
    // "History" in a novel is Historical Fiction, not History.
    expect(classifySubjects(["Fiction", "World War, 1939-1945 -- Fiction", "France -- History -- Fiction"])).toEqual([
      "Historical Fiction",
    ]);
    expect(classifySubjects(["History", "World War, 1939-1945", "Military history"])).toEqual(["History"]);
    expect(classifySubjects(["Biography & Autobiography", "Presidents -- United States -- Biography"])).toEqual([
      "Biography & Memoir",
    ]);
    expect(classifySubjects(["Cooking", "Baking", "Desserts"])).toEqual(["Cooking & Food"]);
  });

  it("caps genres at three plus one audience, and falls back to Fiction or Nonfiction", () => {
    const many = classifySubjects(["Fantasy", "Romance", "Horror", "Mystery", "Thrillers", "Young adult fiction"]);
    expect(many).toHaveLength(4);
    expect(many[0]).toBe("Young Adult");
    expect(classifySubjects(["Fiction", "Large type books"])).toEqual(["Fiction"]);
    expect(classifySubjects(["Nonfiction", "Ireland"])).toEqual(["Nonfiction"]);
    expect(classifySubjects([])).toEqual([]);
  });

  it("only puts a book in Nonfiction when its subjects say so", () => {
    // Novels whose subjects match no genre used to be guessed into Nonfiction.
    expect(classifySubjects(["Women", "Small towns", "Contemporary"])).toEqual(["Fiction"]);
    expect(classifySubjects(["Families", "Large type books"])).toEqual(["Fiction"]);
    // A comic is fiction, so "Dogs" no longer files it under Home & Garden.
    expect(classifySubjects(["Dogs", "Superheroes"])).toEqual(["Comics & Graphic Novels"]);
    expect(classifySubjects(["Juvenile Fiction"])).toEqual(["Children's Books", "Fiction"]);
    // Real nonfiction still gets there.
    expect(classifySubjects(["Nonfiction", "Ireland"])).toEqual(["Nonfiction"]);
    expect(classifySubjects(["Juvenile Nonfiction"])).toEqual(["Children's Books", "Nonfiction"]);
    expect(classifySubjects(["Arctic regions -- Juvenile literature"])).toEqual(["Children's Books", "Nonfiction"]);
  });

  it("reads fiction or nonfiction from the subjects", () => {
    expect(fictionSignal(["Juvenile Nonfiction", "Animals"])).toBe("nonfiction");
    expect(fictionSignal(["Detective and mystery stories"])).toBe("fiction");
    expect(fictionSignal(["Dragons"])).toBeNull();
    // A juvenile nonfiction book about animals is Science & Nature, not a novel.
    expect(classifySubjects(["Juvenile Nonfiction", "Animals", "Dinosaurs"])).toEqual(["Children's Books", "Science & Nature"]);
  });

  it("drops noise and near-duplicates from the subjects it keeps", () => {
    expect(cleanSubjects(["General", "nyt:hardcover-fiction=2001", "Accessible book", "Dragons", "dragon", "Magic"])).toEqual([
      "Dragons",
      "Magic",
    ]);
    // Kept so a book re-filed from its saved subjects still knows it is a novel.
    expect(cleanSubjects(["Fiction", "Nonfiction"])).toEqual(["Fiction", "Nonfiction"]);
  });
});
