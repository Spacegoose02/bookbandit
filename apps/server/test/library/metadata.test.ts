import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { toIsbn13, findIsbn } from "../../src/metadata/isbn.js";
import { metadataFromPath } from "../../src/metadata/filename.js";
import { authorDisplayName, sortTitle } from "../../src/metadata/text.js";
import { readEpub } from "../../src/metadata/epub.js";
import { readCbz } from "../../src/metadata/cbz.js";
import { readPdf } from "../../src/metadata/pdf.js";
import { parseXml } from "../../src/metadata/xml.js";
import { NON_AUTHOR_DIRS } from "../../src/metadata/rating.js";
import { makeCbz, makeEpub, makePdf, tempDir } from "./fixtures.js";

describe("isbn", () => {
  it("converts ISBN-10 to ISBN-13 and validates checksums", () => {
    expect(toIsbn13("0-306-40615-2")).toBe("9780306406157");
    expect(toIsbn13("978-0-306-40615-7")).toBe("9780306406157");
    expect(toIsbn13("urn:isbn:9780306406157")).toBe("9780306406157");
    expect(toIsbn13("9780306406158")).toBeUndefined();
    expect(toIsbn13("12345")).toBeUndefined();
    expect(findIsbn("Some Book 9780306406157 retail")).toBe("9780306406157");
  });
});

describe("text", () => {
  it("builds sort titles and flips author names", () => {
    expect(sortTitle("The Hobbit")).toBe("hobbit, the");
    expect(authorDisplayName("Tolkien, J. R. R.")).toBe("J. R. R. Tolkien");
    expect(authorDisplayName("Dr. Seuss")).toBe("Dr. Seuss");
  });
});

describe("metadata from path", () => {
  it("reads Calibre's Author/Title (id)/file layout", () => {
    const m = metadataFromPath("Roald Dahl/Matilda (42)/Matilda - Roald Dahl.epub");
    expect(m).toMatchObject({ title: "Matilda", authors: ["Roald Dahl"] });
  });

  it("reads 'Author - Title (Series #2)'", () => {
    const m = metadataFromPath("inbox/Rick Riordan - The Sea of Monsters (Percy Jackson #2) [retail].epub", NON_AUTHOR_DIRS);
    expect(m).toMatchObject({ title: "The Sea of Monsters", authors: ["Rick Riordan"], series: "Percy Jackson", seriesPosition: 2 });
  });

  it("uses an author folder and ignores rating folders", () => {
    expect(metadataFromPath("kids/Mo Willems/Knuffle Bunny.pdf", NON_AUTHOR_DIRS)).toMatchObject({
      title: "Knuffle Bunny",
      authors: ["Mo Willems"],
    });
    expect(metadataFromPath("adult/Some Title.epub", NON_AUTHOR_DIRS).authors).toBeUndefined();
  });
});

describe("file readers", () => {
  it("reads EPUB OPF metadata, series and cover", async () => {
    const dir = await tempDir();
    const path = join(dir, "b.epub");
    await makeEpub(path, {
      title: "Matilda",
      authors: ["Dahl, Roald"],
      isbn: "0-14-241037-3",
      subjects: ["Juvenile Fiction"],
      series: "Dahl Classics",
      seriesIndex: 3,
      description: "A <b>clever</b> girl",
      cover: true,
    });
    const m = await readEpub(path);
    expect(m).toMatchObject({
      title: "Matilda",
      authors: ["Roald Dahl"],
      isbn13: "9780142410370",
      language: "en",
      publishedYear: 2019,
      subjects: ["Juvenile Fiction"],
      series: "Dahl Classics",
      seriesPosition: 3,
      description: "A clever girl",
    });
    expect(m.cover?.mime).toBe("image/png");
  });

  it("does not expand entities declared in a DOCTYPE", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><t>&lol2;</t>`;
    const parsed = parseXml(bomb) as { t: string };
    expect(parsed.t).not.toContain("lollol");
  });

  it("reads ComicInfo.xml and counts pages in a CBZ", async () => {
    const dir = await tempDir();
    const path = join(dir, "c.cbz");
    await makeCbz(path, { Series: "Dog Man", Number: "4", Writer: "Dav Pilkey", AgeRating: "Everyone 10+", Genre: "Humor, Kids" });
    const m = await readCbz(path);
    expect(m).toMatchObject({ series: "Dog Man", seriesPosition: 4, title: "Dog Man #4", authors: ["Dav Pilkey"], ageRating: "Everyone 10+", pageCount: 3 });
    expect(m.subjects).toEqual(["Humor", "Kids"]);
    expect(m.cover?.data.length).toBeGreaterThan(0);
  });

  it("reads the PDF info dictionary", async () => {
    const dir = await tempDir();
    const path = join(dir, "p.pdf");
    await makePdf(path, { title: "The Joy of Cooking", author: "Irma Rombauer", keywords: ["Cooking"], pages: 4 });
    const m = await readPdf(path, 1000);
    expect(m).toMatchObject({ title: "The Joy of Cooking", authors: ["Irma Rombauer"], subjects: ["Cooking"], pageCount: 4 });
  });
});
