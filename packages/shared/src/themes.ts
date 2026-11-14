/**
 * Theme ids a user can pick. Stored in `users.theme`; the web app owns the actual colors.
 * Kept here so the server can validate `PATCH /api/me { theme }`.
 */
export const THEME_IDS = [
  "dark",
  "light",
  "nuclear",
  "retro",
  "pink",
  "school",
  "gaming",
  "dinosaur",
  "storm",
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = "dark";

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}
