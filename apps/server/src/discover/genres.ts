/**
 * Genre rows for Discover, named after the curated categories (taxonomy.ts) so a "Fantasy" row
 * here is the same "Fantasy" as on the Categories page and the home page.
 */

/** Curated category → Open Library search for that genre. Only genres listed here get an outside row. */
export const GENRE_QUERIES: Record<string, string> = {
  Fantasy: `subject:fantasy -subject:"juvenile fiction"`,
  "Science Fiction": `subject:"science fiction" -subject:"juvenile fiction"`,
  "Mystery & Crime": `subject:("detective and mystery stories" OR "mystery fiction")`,
  "Thriller & Suspense": `subject:(thriller OR thrillers OR suspense)`,
  Romance: `subject:(romance OR "love stories") -subject:"juvenile fiction"`,
  "Historical Fiction": `subject:"historical fiction"`,
  Horror: `subject:"horror fiction"`,
  "Literary Fiction": `subject:"literary fiction"`,
  "Comics & Graphic Novels": `subject:("graphic novels" OR comics)`,
  "Biography & Memoir": `subject:(biography OR memoir OR autobiography) -subject:fiction`,
  History: `subject:history -subject:fiction`,
  "Science & Nature": `subject:(science OR nature) -subject:fiction`,
  "Self-Help": `subject:"self-help"`,
  "Cooking & Food": `subject:(cooking OR cookbooks)`,
  "Young Adult": `subject:"young adult fiction"`,
  "Children's Books": `subject:"juvenile fiction" subject:("picture books" OR "children's stories" OR animals)`,
};

/** Outside rows for grown-ups under "For the kids" (Open Library, so unrated: never shown to kids). */
export const KID_QUERIES: { id: string; name: string; q: string }[] = [
  { id: "ol-picture-books", name: "Popular picture books", q: `subject:"picture books"` },
  { id: "ol-early-readers", name: "Popular early readers", q: `subject:("readers (primary)" OR "early readers" OR "beginning readers")` },
  { id: "ol-chapter-books", name: "Popular chapter books", q: `subject:"chapter books"` },
  { id: "ol-middle-grade", name: "Popular with 8 to 12s", q: `subject:"juvenile fiction" -subject:"picture books" -subject:"young adult fiction"` },
];

/** Display names for rows that read better than the category name. */
export const GENRE_ROW_NAMES: Record<string, string> = {
  "Children's Books": "Popular with kids",
  "Young Adult": "Popular with teens",
  "Comics & Graphic Novels": "Comics & graphic novels",
  "Biography & Memoir": "Biography & memoir",
  "Science & Nature": "Science & nature",
  "Mystery & Crime": "Mystery & crime",
  "Thriller & Suspense": "Thrillers",
  "Historical Fiction": "Historical fiction",
  "Literary Fiction": "Literary fiction",
  "Science Fiction": "Science fiction",
  "Cooking & Food": "Cooking",
};

/** Adult rows when there's no reading history to go on, in this order. */
export const DEFAULT_GENRES = [
  "Fantasy",
  "Mystery & Crime",
  "Romance",
  "Science Fiction",
  "Thriller & Suspense",
  "Historical Fiction",
  "Biography & Memoir",
  "Young Adult",
  "Horror",
  "History",
  "Comics & Graphic Novels",
];

/** Most genre rows on one page. */
export const MAX_GENRE_ROWS = 8;

/** Subjects too broad to say anything about a book ("Fiction", "Accessible book"). */
const GENERIC_SUBJECT =
  /^(fiction|general|fiction,? general|novels?|literature|english (fiction|literature)|american (fiction|literature)|juvenile (fiction|literature)|large (type|print) books?|accessible book|protected daisy|in library|lending library|long now.*|nyt:.*|new york times.*|reading level.*|open library.*|ebooks?|electronic books?)$/i;

export function usefulSubject(name: string): boolean {
  return name.length >= 3 && name.length <= 60 && !GENERIC_SUBJECT.test(name.trim());
}

/** Open Library query for books on the same subjects, or null if none are specific enough. */
export function subjectQuery(subjects: string[]): string | null {
  const picks = subjects
    .filter(usefulSubject)
    .map((s) => s.replace(/["\\()]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (!picks.length) return null;
  return `subject:(${picks.map((s) => `"${s}"`).join(" OR ")})`;
}

export function authorQuery(name: string): string {
  return `author:"${name.replace(/["\\]/g, " ").trim()}"`;
}
