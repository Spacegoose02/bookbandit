/**
 * Automatic content ratings from the signals we have at import time.
 *
 * Fail closed: every signal proposes a rating and the most restrictive one wins.
 * No signal at all leaves the book unrated, which the content lock treats as adult.
 * An admin-set rating is never replaced (see `shouldReplaceRating`).
 *
 * Signals, strongest first:
 *  - folder:   the file lives under a rating folder, e.g. /books/adult/… or /books/kids/…
 *  - metadata: Google Books maturityRating, ComicInfo AgeRating
 *  - keywords: genres/subjects/content warnings ("Erotica", "Juvenile Fiction", "Young Adult")
 */
import { ratingRank, UNRATED_FALLBACK, type ContentRating } from "@bookbandit/shared";
import type { BookMetadata } from "./types.js";

export type RatingSource = "admin" | "folder" | "metadata" | "ai" | "keywords";

export interface RatingSignal {
  rating: ContentRating;
  source: Exclude<RatingSource, "admin" | "ai">;
  reason: string;
}

/** Folder name (any depth, case-insensitive) → rating. */
export const RATING_FOLDERS: Record<string, ContentRating> = {
  explicit: "explicit",
  erotica: "explicit",
  adult: "adult",
  adults: "adult",
  mature: "adult",
  teen: "teen",
  "young-adult": "teen",
  "young adult": "teen",
  ya: "teen",
  "middle-grade": "middle_grade",
  "middle grade": "middle_grade",
  kids: "kids",
  children: "kids",
  childrens: "kids",
  "picture-books": "kids",
};

/** Names the filename parser should never mistake for an author. */
export const NON_AUTHOR_DIRS: ReadonlySet<string> = new Set([...Object.keys(RATING_FOLDERS), "inbox", "books", "ebooks", "comics", "manga"]);

export function folderSignals(relPath: string): RatingSignal[] {
  const dirs = relPath.split("/").slice(0, -1);
  const out: RatingSignal[] = [];
  for (const d of dirs) {
    const rating = RATING_FOLDERS[d.toLowerCase()];
    if (rating) out.push({ rating, source: "folder", reason: `in folder "${d}"` });
  }
  return out;
}

// Order matters only for readability; every matching rule contributes a signal.
const KEYWORD_RULES: { pattern: RegExp; rating: ContentRating }[] = [
  { pattern: /\b(erotica|erotic|smut|bdsm|porn\w*|hentai|(?<!young\s)adult\s+romance|dark\s+romance|explicit\s+sex\w*)\b/i, rating: "explicit" },
  { pattern: /\b(sexual\s+content|sexual\s+assault|rape|graphic\s+violence|gore|drug\s+use|self[-\s]harm|suicide)\b/i, rating: "adult" },
  { pattern: /\b(mature|(?<!young\s)adult\s+fiction|horror|true\s+crime)\b/i, rating: "adult" },
  { pattern: /\b(young\s+adult|teen(s|age)?\s+(fiction|nonfiction|readers?)|ya\s+fiction)\b/i, rating: "teen" },
  { pattern: /\b(middle\s+grade|juvenile|children'?s\s+(fiction|literature|books?)|ages?\s+(8|9|10)\s*(-|to)\s*12)\b/i, rating: "middle_grade" },
  { pattern: /\b(picture\s+books?|board\s+books?|early\s+readers?|beginner\s+readers?|bedtime\s+stor(y|ies)|nursery\s+rhymes?|ages?\s+[2-6]\s*(-|to)\s*[5-8])\b/i, rating: "kids" },
];

/** ComicInfo.xml AgeRating values (Anansi project list). */
const COMIC_AGE: Record<string, ContentRating> = {
  "adults only 18+": "explicit",
  "x18+": "explicit",
  "r18+": "explicit",
  "mature 17+": "adult",
  m: "adult",
  "ma15+": "teen",
  "teen": "teen",
  "rating pending": "adult",
  "everyone 10+": "middle_grade",
  "g": "kids",
  "pg": "middle_grade",
  "kids to adults": "kids",
  "everyone": "kids",
  "early childhood": "kids",
};

export function metadataSignals(meta: BookMetadata, maturity?: "MATURE" | "NOT_MATURE"): RatingSignal[] {
  const out: RatingSignal[] = [];
  // Google's flag is a floor, never a lowering signal: NOT_MATURE says nothing about age.
  if (maturity === "MATURE") out.push({ rating: "adult", source: "metadata", reason: "Google Books marks it mature" });
  if (meta.ageRating) {
    const r = COMIC_AGE[meta.ageRating.trim().toLowerCase()];
    if (r) out.push({ rating: r, source: "metadata", reason: `comic age rating "${meta.ageRating}"` });
  }
  return out;
}

export function keywordSignals(meta: BookMetadata): RatingSignal[] {
  const out: RatingSignal[] = [];
  const terms = [...(meta.subjects ?? []), ...(meta.contentWarnings ?? [])];
  for (const term of terms) {
    for (const rule of KEYWORD_RULES) {
      if (rule.pattern.test(term)) out.push({ rating: rule.rating, source: "keywords", reason: `genre "${term}"` });
    }
  }
  return out;
}

/** The most restrictive signal, or null when there are none (book stays unrated = adult). */
export function decideRating(signals: RatingSignal[]): RatingSignal | null {
  let best: RatingSignal | null = null;
  for (const s of signals) {
    if (!best || ratingRank(s.rating) > ratingRank(best.rating)) best = s;
  }
  return best;
}

export function autoRating(input: {
  relPaths: string[];
  metadata: BookMetadata;
  maturity?: "MATURE" | "NOT_MATURE";
}): RatingSignal | null {
  return decideRating([
    ...input.relPaths.flatMap(folderSignals),
    ...metadataSignals(input.metadata, input.maturity),
    ...keywordSignals(input.metadata),
  ]);
}

/**
 * Whether an automatic rating may replace the current one. Admin ratings are final.
 *
 * Books still in the inbox take the freshly computed rating (callers pass every signal they
 * have, including all of the book's file paths), and an admin reviews it on approval.
 * Once a book is approved, automatic ratings may only make it more restrictive, so a
 * later lookup can never quietly unlock a book a kid couldn't see before. Unrated
 * counts as adult here, like everywhere else.
 */
export function shouldReplaceRating(
  current: { rating: ContentRating | null; ratingSource: RatingSource | null; approved: boolean },
  next: RatingSignal,
): boolean {
  if (current.ratingSource === "admin") return false;
  if (!current.approved) return true;
  return ratingRank(next.rating) > ratingRank(current.rating ?? UNRATED_FALLBACK);
}
