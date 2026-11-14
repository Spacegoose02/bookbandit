import { describe, expect, it } from "vitest";
import { THEME_IDS } from "@bookbandit/shared";
import { contrastRatio, THEME_LIST, THEMES, themeOrDefault } from "./themes";

describe("themes", () => {
  it("defines every shared theme id", () => {
    for (const id of THEME_IDS) expect(THEMES[id].id).toBe(id);
  });

  it("falls back to dark for unknown ids", () => {
    expect(themeOrDefault("glitter").id).toBe("dark");
  });

  // WCAG AA: 4.5:1 for body text. Kids and grown-ups both need to read these.
  it.each(THEME_LIST.map((t) => [t.id, t] as const))("%s keeps text readable", (_id, t) => {
    const c = t.colors;
    expect(contrastRatio(c.text, c.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.text, c.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.muted, c.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.readerText, c.readerBg)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(c.accentText, c.accent)).toBeGreaterThanOrEqual(4.5);
  });
});
