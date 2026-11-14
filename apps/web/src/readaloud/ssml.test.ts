import { describe, expect, it } from "vitest";
import { chunkText, markAt, parseSsml, sentenceAround, wordAround, wordSchedule } from "./ssml";

const SSML = `<speak xmlns="http://www.w3.org/2001/10/synthesis"><mark name="0"/>Pip   the <emphasis><mark name="1"/>mouse</emphasis> <mark name="2"/>ran. <mark name="3"/>Hazel <mark name="4"/>waved!</speak>`;

describe("parseSsml", () => {
  it("collapses whitespace and keeps marks on their words", () => {
    const b = parseSsml(SSML);
    expect(b.text).toBe("Pip the mouse ran. Hazel waved!");
    expect(b.marks.map((m) => m.word)).toEqual(["Pip", "mouse", "ran", "Hazel", "waved"]);
    expect(b.marks[3]!.offset).toBe(b.text.indexOf("Hazel"));
  });
});

describe("chunkText", () => {
  it("packs whole sentences up to the limit", () => {
    const text = "One two. Three four! Five six?";
    expect(chunkText(text, 100).map((c) => c.text)).toEqual(["One two. Three four! Five six?"]);
    expect(chunkText(text, 12).map((c) => c.text)).toEqual(["One two.", "Three four!", "Five six?"]);
  });
  it("splits one very long sentence at commas or spaces", () => {
    const long = "word ".repeat(100).trim() + ".";
    const chunks = chunkText(long, 80);
    expect(chunks.every((c) => c.text.length <= 80)).toBe(true);
    expect(chunks.map((c) => c.text).join(" ")).toBe(long);
  });
  it("keeps offsets pointing into the text", () => {
    const text = "Hi there. Bye now.";
    for (const c of chunkText(text, 10)) expect(text.slice(c.start, c.end)).toBe(c.text);
  });
});

describe("wordSchedule", () => {
  const b = parseSsml(SSML);
  const [chunk] = chunkText(b.text, 300);
  it("uses the server's word timings, skipping punctuation tokens", () => {
    const timings = [
      { word: "Pip", start: 0, end: 0.3 },
      { word: "the", start: 0.3, end: 0.4 },
      { word: "mouse", start: 0.4, end: 0.8 },
      { word: "ran", start: 0.8, end: 1.1 },
      { word: ".", start: 1.1, end: 1.2 },
      { word: "Hazel", start: 1.5, end: 1.9 },
      { word: "waved", start: 1.9, end: 2.3 },
    ];
    const s = wordSchedule(chunk!, b.marks, timings, 2.5);
    expect(s.map((x) => x.at)).toEqual([0, 0.4, 0.8, 1.5, 1.9]);
    expect(markAt(s, 1.6)).toBe("3");
    expect(markAt(s, 0.1)).toBe("0");
  });
  it("estimates by position without timings", () => {
    const s = wordSchedule(chunk!, b.marks, null, 3.1);
    expect(s[0]!.at).toBe(0);
    expect(s[4]!.at).toBeGreaterThan(s[3]!.at);
    expect(s[4]!.at).toBeLessThan(3.1);
  });
});

describe("tap a word", () => {
  it("finds the word under a tap and its sentence", () => {
    const t = "The fox “scampered” away. Then it slept.";
    const at = t.indexOf("amp");
    expect(wordAround(t, at)).toMatchObject({ word: "scampered" });
    expect(wordAround(t, t.indexOf("”"))).toMatchObject({ word: "scampered" });
    expect(wordAround(t, t.indexOf(" “") + 1)).toBeNull();
    const w = wordAround(t, at)!;
    expect(sentenceAround(t, w.start, w.end)).toBe("The fox “scampered” away.");
  });
});
