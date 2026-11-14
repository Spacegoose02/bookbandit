import { describe, expect, it } from "vitest";
import { THEME_IDS } from "@bookbandit/shared";
import { contrastRatio, THEME_GROUPS, THEME_LIST, THEMES, themeOrDefault } from "./themes";

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

  // Focus rings and accent buttons are "non-text" UI: WCAG asks for 3:1 against the page.
  it.each(THEME_LIST.map((t) => [t.id, t] as const))("%s keeps focus rings and buttons visible", (_id, t) => {
    expect(contrastRatio(t.colors.focus, t.colors.bg)).toBeGreaterThanOrEqual(3);
  });

  it("puts every theme in a picker group", () => {
    const groups = new Set(THEME_GROUPS.map((g) => g.id));
    for (const t of THEME_LIST) expect(groups.has(t.group)).toBe(true);
  });

  it("gives every kid picture theme a scene and a few buddies", () => {
    const kidThemes = THEME_LIST.filter((t) => t.scene);
    expect(kidThemes.map((t) => t.id).sort()).toEqual(["builder", "castle", "dinosaur", "jungle", "sea", "space", "unicorn"]);
    for (const t of kidThemes) {
      expect(t.scene).toMatch(/^url\("data:image\/svg\+xml/);
      expect(t.buddies!.length).toBeGreaterThanOrEqual(5);
    }
  });
});
