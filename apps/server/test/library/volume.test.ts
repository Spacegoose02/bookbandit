import { describe, expect, it } from "vitest";
import { bookVolume, differentBooks, seriesInTitle, volumeFromPath, volumeIn, withVolume } from "../../src/metadata/volume.js";
import { metadataFromPath } from "../../src/metadata/filename.js";

const MINECRAFT_6 =
  "Kid, Cube/Minecraft_ Diary of a Wimpy Villager (Book 6)_ (An unofficial Minecraft book) (262)/Minecraft_ Diary of a Wimpy Villager (Book - Kid, Cube.epub";

describe("volume numbers", () => {
  it("reads book numbers from titles and names", () => {
    expect(volumeIn("Diary of a Wimpy Villager (Book 6)")).toBe(6);
    expect(volumeIn("Diary of a Wimpy Villager: book 4")).toBe(4);
    expect(volumeIn("Naruto, Vol. 3")).toBe(3);
    expect(volumeIn("Wings of Fire Book Two")).toBe(2);
    expect(volumeIn("Dog Man #1")).toBe(1);
    expect(volumeIn("The Book Thief")).toBeUndefined();
    expect(volumeIn("Fahrenheit 451")).toBeUndefined();
    expect(volumeIn("Percy Jackson Books 1-3")).toBeUndefined(); // an omnibus has no single number
    expect(volumeIn("(An unofficial Minecraft book) (262)")).toBeUndefined(); // Calibre's id isn't a volume
  });

  it("reads the number from a file name, else its folder (Calibre truncates file names)", () => {
    expect(volumeFromPath(MINECRAFT_6)).toBe(6);
    expect(volumeFromPath("Roald Dahl/Matilda (42)/Matilda - Roald Dahl.epub")).toBeUndefined();
  });

  it("splits series facts out of titles", () => {
    expect(seriesInTitle("The Sea of Monsters (Percy Jackson #2)")).toEqual({ title: "The Sea of Monsters", series: "Percy Jackson", position: 2 });
    expect(seriesInTitle("Minecraft: Diary of a Wimpy Villager (Book 6): (An unofficial Minecraft book)")).toEqual({
      title: "Minecraft: Diary of a Wimpy Villager, Book 6",
      series: "Minecraft: Diary of a Wimpy Villager",
      position: 6,
      subtitle: "An unofficial Minecraft book",
    });
    expect(seriesInTitle("Minecraft: Diary of a Wimpy Villager: book 4")).toEqual({
      title: "Minecraft: Diary of a Wimpy Villager: book 4",
      series: "Minecraft: Diary of a Wimpy Villager",
      position: 4,
    });
    expect(seriesInTitle("Matilda")).toEqual({ title: "Matilda" });
  });

  it("gets a proper title and series from a Calibre folder", () => {
    expect(metadataFromPath(MINECRAFT_6)).toMatchObject({
      title: "Minecraft: Diary of a Wimpy Villager, Book 6",
      subtitle: "An unofficial Minecraft book",
      authors: ["Cube Kid"],
      series: "Minecraft: Diary of a Wimpy Villager",
      seriesPosition: 6,
    });
  });

  it("numbers a file title that leaves the volume out, but not a volume's own title", () => {
    expect(withVolume({ title: "Minecraft: Diary of a Wimpy Villager" }, 6)).toEqual({
      title: "Minecraft: Diary of a Wimpy Villager, Book 6",
      series: "Minecraft: Diary of a Wimpy Villager",
      seriesPosition: 6,
    });
    expect(withVolume({ title: "Minecraft: Diary of a Wimpy Villager", series: "Diary of a Wimpy Villager", seriesPosition: 3 }).title).toBe(
      "Minecraft: Diary of a Wimpy Villager, Book 3",
    );
    expect(withVolume({ title: "The Sea of Monsters", series: "Percy Jackson", seriesPosition: 2 }).title).toBe("The Sea of Monsters");
    expect(withVolume({ title: "Harry Potter and the Goblet of Fire", series: "Harry Potter", seriesPosition: 4 }).title).toBe(
      "Harry Potter and the Goblet of Fire",
    );
  });

  it("tells different volumes and ISBNs apart", () => {
    expect(differentBooks({ volume: 4 }, { volume: 6 })).toBe(true);
    expect(differentBooks({ volume: 4 }, { volume: 4 })).toBe(false);
    expect(differentBooks({ volume: 4 }, {})).toBe(false);
    expect(differentBooks({ isbn13: "9780000000001" }, { isbn13: "9780000000002" })).toBe(true);
    expect(differentBooks({ isbn13: "9780000000001" }, { isbn13: "9780000000002" }, { ignoreIsbn: true })).toBe(false);
    expect(bookVolume(null, "Minecraft: Diary of a Wimpy Villager", [MINECRAFT_6])).toBe(6);
    expect(bookVolume(2, "Anything (Book 6)")).toBe(2);
  });
});
