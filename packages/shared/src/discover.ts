/** Discover, series and category rules shared by the server and the web app. */

/** Where a Discover book stands for this household. */
export type DiscoverStatus = "library" | "kindle" | "request";

/** Category (tag) names that mean "this is a cookbook": the web app offers Cook mode for them. */
const COOKBOOK = /\b(cook(ing|ery|books?)?|recipes?|baking|bakery|kitchen|food\s*&\s*drink|cuisine)\b/i;

export function isCookbookCategory(name: string): boolean {
  return COOKBOOK.test(name);
}

/** Kindle ASINs are 10 letters/digits (B0… for Kindle books, or an ISBN-10). */
export function isAsin(value: string): boolean {
  return /^[A-Z0-9]{10}$/i.test(value.trim());
}

/** Link that opens a Kindle book in Amazon's web reader (the Kindle app takes over on tablets). */
export function kindleReadUrl(asin: string): string {
  return `https://read.amazon.com/?asin=${encodeURIComponent(asin.trim().toUpperCase())}`;
}
