/**
 * Book fields an admin can lock. A locked field keeps the admin's value: metadata refresh, rescans,
 * Calibre imports and the auto-categorizer never change it. Editing a field locks it.
 */
export const BOOK_LOCK_FIELDS = [
  "title",
  "sortTitle",
  "originalTitle",
  "subtitle",
  "authors",
  "series",
  "publishedYear",
  "publisher",
  "isbn13",
  "language",
  "pageCount",
  "rating",
  "description",
  "categories",
  "cover",
] as const;

export type BookLockField = (typeof BOOK_LOCK_FIELDS)[number];

export function isBookLockField(s: string): s is BookLockField {
  return (BOOK_LOCK_FIELDS as readonly string[]).includes(s);
}
