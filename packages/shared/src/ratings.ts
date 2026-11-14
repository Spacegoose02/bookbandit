/**
 * Content ratings, ordered from most to least restrictive audience.
 * The server enforces these on every query; the UI only reflects them.
 */
export const CONTENT_RATINGS = ["kids", "middle_grade", "teen", "adult", "explicit"] as const;
export type ContentRating = (typeof CONTENT_RATINGS)[number];

/** Minimum reader age for each rating. Explicit additionally needs an adult opt-in. */
export const RATING_MIN_AGE: Record<ContentRating, number> = {
  kids: 0,
  middle_grade: 8,
  teen: 13,
  adult: 18,
  explicit: 18,
};

export const RATING_LABELS: Record<ContentRating, string> = {
  kids: "Kids (up to 7)",
  middle_grade: "Middle grade (8 to 12)",
  teen: "Teen (13+)",
  adult: "Adult (18+)",
  explicit: "Explicit",
};

/** Books with no rating yet are treated as this until reviewed (fail closed). */
export const UNRATED_FALLBACK: ContentRating = "adult";

export function ratingRank(rating: ContentRating): number {
  return CONTENT_RATINGS.indexOf(rating);
}

/** Age in whole years on `today`, from a birth year (birthdays assumed Jan 1 — errs toward the younger age). */
export function ageFromBirthYear(birthYear: number, today: Date = new Date()): number {
  return Math.max(0, today.getUTCFullYear() - birthYear - 1);
}

export interface ReaderAccess {
  /** null for adults whose age isn't tracked */
  birthYear: number | null;
  isKid: boolean;
  /** Adults must opt in to explicit content themselves; kids can never. */
  explicitOptIn: boolean;
}

/**
 * The highest rating this reader may see. Kids: strictly by age.
 * Adults: "adult", or "explicit" if they opted in.
 */
export function maxAllowedRating(reader: ReaderAccess, today: Date = new Date()): ContentRating {
  if (!reader.isKid) {
    return reader.explicitOptIn ? "explicit" : "adult";
  }
  // A kid with no birth year gets the most restrictive rating.
  if (reader.birthYear == null) return "kids";
  const age = ageFromBirthYear(reader.birthYear, today);
  if (age >= RATING_MIN_AGE.adult) return "adult"; // aged out of kid limits; explicit still needs opt-in
  if (age >= RATING_MIN_AGE.teen) return "teen";
  if (age >= RATING_MIN_AGE.middle_grade) return "middle_grade";
  return "kids";
}

/** Ratings a reader may see, for use in SQL `IN (...)` filters. */
export function allowedRatings(reader: ReaderAccess, today: Date = new Date()): ContentRating[] {
  const max = ratingRank(maxAllowedRating(reader, today));
  return CONTENT_RATINGS.filter((r) => ratingRank(r) <= max);
}

export function canSee(
  reader: ReaderAccess,
  bookRating: ContentRating | null | undefined,
  today: Date = new Date(),
): boolean {
  const effective = bookRating ?? UNRATED_FALLBACK;
  return ratingRank(effective) <= ratingRank(maxAllowedRating(reader, today));
}
