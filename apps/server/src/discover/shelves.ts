/**
 * Discover rows built from the family's own library: kids' age bands and themes, moods, new
 * arrivals, books nobody has opened yet, quick reads, parent picks and "Surprise me".
 *
 * Every query here starts from `visibleBooksWhere(reader)` (CLAUDE.md rule 1), so a kid only ever
 * gets books within their own limit, and grown-ups' "For the kids" rows add a kids' rating filter
 * on top.
 */
import { and, desc, eq, inArray, isNotNull, lte, notExists, notInArray, or, sql, type SQL } from "drizzle-orm";
import { maxAllowedRating, ratingRank, type ContentRating } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { books, bookTags, familyPicks, kidShelf, readingProgress, tags, users } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { visibleBooksWhere } from "../content/lock.js";
import { enrich, type BookSummary } from "../catalog/list.js";

/** A row of books whose categories or subjects match a pattern. */
export interface TagRow {
  id: string;
  name: string;
  /** Name shown to kids, when it should read differently. */
  kidName?: string;
  match: RegExp;
  /** Only books with one of these ratings (on top of the reader's own limit). */
  ratings?: ContentRating[];
  /** Short line shown under the row title. */
  blurb?: string;
}

const LITTLE: ContentRating[] = ["kids"];
const KIDS: ContentRating[] = ["kids", "middle_grade"];

/** Age bands, youngest first. A band only shows when it has books the reader may open. */
export const AGE_BANDS: TagRow[] = [
  { id: "kids-picture-books", name: "Picture books", match: /picture books?|board books?|stories in rhyme|concept books?|toddler/i, ratings: LITTLE },
  { id: "kids-early-readers", name: "Early readers", kidName: "Books I can read myself", match: /early readers?|beginning readers?|easy readers?|readers \(primary\)|first readers?|phonics|i can read|level [1-3] reader/i, ratings: LITTLE },
  { id: "kids-chapter-books", name: "Chapter books", kidName: "Chapter books", match: /chapter books?|early chapter|first chapter/i, ratings: KIDS },
  { id: "kids-middle-grade", name: "Middle grade (8 to 12)", kidName: "Big-kid books", match: /juvenile fiction|children's (stories|fiction|books)|middle grade|^children's books$/i, ratings: ["middle_grade"] },
  { id: "kids-teen", name: "Teen reads", kidName: "Teen reads", match: /young adult|teen|^ya$/i, ratings: ["teen"] },
];

/** Themes kids ask for. Shown to kids, and to grown-ups under "For the kids" (kids' ratings only). */
export const KID_THEMES: TagRow[] = [
  { id: "kids-animals", name: "Animal stories", kidName: "Animals!", match: /animals?|dogs?|cats?|horses?|ponies|pets?|bears?|rabbits?|bunn|foxes|owls?|pigs?|farm|zoo|wildlife|dinosaurs?|elephants?|penguins?/i, ratings: KIDS },
  { id: "kids-funny", name: "Funny books", kidName: "Make me laugh", match: /humou?r|funny|comic|jokes|silly|laugh/i, ratings: KIDS },
  { id: "kids-bedtime", name: "Bedtime stories", kidName: "Bedtime stories", match: /bedtime|lullab|sleep|goodnight|good night|night(time)?\b|dreams?/i, ratings: LITTLE },
  { id: "kids-magic", name: "Magic and dragons", kidName: "Magic and dragons", match: /fantasy|magic|dragons?|wizards?|witch|fairies|fairy tales?|unicorns?|princess|mermaids?/i, ratings: KIDS },
  { id: "kids-adventure", name: "Adventures", kidName: "Big adventures", match: /adventure|pirates?|treasure|explor|quests?|survival|journeys?/i, ratings: KIDS },
  { id: "kids-mystery", name: "Kid detectives", kidName: "Mysteries to solve", match: /myster|detective|sleuth|puzzles?|secrets?/i, ratings: KIDS },
  { id: "kids-space", name: "Space, science and robots", kidName: "Space and robots", match: /space|planets?|astronaut|rockets?|robots?|science|stars\b|inventions?/i, ratings: KIDS },
  { id: "kids-friends", name: "Friends and feelings", kidName: "Friends and feelings", match: /friendship|friends|feelings|emotions|kindness|sharing|family life|families|school/i, ratings: KIDS },
];

/** Moods: one row each, shown as tabs. No rating filter beyond the reader's own. */
export const MOODS: TagRow[] = [
  { id: "mood-cozy", name: "Cozy", match: /cozy|cosy|small town|village|tea|cooking|baking|gentle|domestic fiction|friendship|families|family life|knitting|garden/i, blurb: "Warm, gentle, low-stakes" },
  { id: "mood-thrilling", name: "Edge of your seat", match: /thriller|suspense|espionage|spy|spies|action|chase|survival|heist|conspirac/i, blurb: "Thrillers, chases and close calls" },
  { id: "mood-funny", name: "Funny", match: /humou?r|funny|comic|comedy|satire|jokes|silly|laugh/i, blurb: "Books to make you laugh" },
  { id: "mood-heartwarming", name: "Heartwarming", match: /love|romance|kindness|friendship|hope|inspirational|families|feel.?good|coming of age/i, blurb: "Love, friendship and happy endings" },
  { id: "mood-spooky", name: "Spooky", match: /horror|ghosts?|haunted|spooky|monsters?|vampires?|witch|halloween|supernatural|scary/i, blurb: "Ghosts, monsters and shivers" },
  { id: "mood-curious", name: "Curious", match: /science|history|nature|how things work|biograph|space|animals|inventions?|discover|explor/i, blurb: "Learn something amazing" },
  { id: "mood-epic", name: "Epic worlds", match: /fantasy|epic|science fiction|space opera|dragons?|magic|quests?|kingdoms?/i, blurb: "Big worlds to get lost in" },
];

const SUMMARY = {
  id: books.id,
  title: books.title,
  publishedYear: books.publishedYear,
  rating: books.rating,
  coverPath: books.coverPath,
  kindleOnly: books.kindleOnly,
};

export type TagList = { id: string; name: string }[];

/** Every tag's id and name, read once per page and matched in memory. */
export function allTags(db: Db): TagList {
  return db.select({ id: tags.id, name: tags.name }).from(tags).all();
}

/** Tag ids (categories or raw subjects) whose names match. */
function tagIds(list: TagList, match: RegExp): string[] {
  return list.filter((t) => match.test(t.name)).map((t) => t.id);
}

function pickRows(db: Db, reader: Reader, where: (SQL | undefined)[], exclude: Set<string>, limit: number, order: SQL[]): BookSummary[] {
  const rows = db
    .select(SUMMARY)
    .from(books)
    .where(and(visibleBooksWhere(reader), ...where))
    .orderBy(...order)
    .limit(limit + exclude.size)
    .all()
    .filter((b) => !exclude.has(b.id))
    .slice(0, limit);
  return enrich(db, reader, rows);
}

/** A seed that changes once a day, so tag rows don't show the same books in the same order forever. */
function daySeed(now: number): number {
  return Math.floor(now / 86_400_000) % 997;
}
/** Stable shuffle per day: books ordered by a hash of their id and the day. */
function shuffled(now: number): SQL {
  const seed = daySeed(now);
  return sql`(unicode(substr(${books.id}, 1, 1)) * 31 + unicode(substr(${books.id}, 5, 1)) * 7 + unicode(substr(${books.id}, 10, 1)) + ${seed}) % 97`;
}

export function tagRow(db: Db, reader: Reader, row: TagRow, exclude: Set<string>, limit: number, now: number, list: TagList): BookSummary[] {
  const ids = tagIds(list, row.match);
  if (!ids.length) return [];
  return pickRows(
    db,
    reader,
    [
      inArray(books.id, db.select({ id: bookTags.bookId }).from(bookTags).where(inArray(bookTags.tagId, ids))),
      row.ratings ? inArray(books.rating, row.ratings) : undefined,
    ],
    exclude,
    limit,
    [shuffled(now), desc(books.addedAt)],
  );
}

/** Age bands and themes in the order that suits this reader: the youngest bands first for little kids. */
export function kidRowsFor(reader: Reader, today = new Date()): TagRow[] {
  if (!reader.isKid) return [...AGE_BANDS.filter((b) => b.id !== "kids-teen"), ...KID_THEMES];
  const max = ratingRank(maxAllowedRating(reader, today));
  // A kid's own rows: bands up to their limit (the lock enforces it anyway), and every theme.
  const bands = AGE_BANDS.filter((b) => b.ratings!.some((r) => ratingRank(r) <= max));
  const little = max <= ratingRank("kids");
  return little ? [...bands, ...KID_THEMES] : [...bands.reverse(), ...KID_THEMES];
}

/** Newest additions to the library this reader may open. */
export function newArrivals(db: Db, reader: Reader, exclude: Set<string>, limit: number): BookSummary[] {
  return pickRows(db, reader, [], exclude, limit, [desc(books.addedAt)]);
}

/** Books nobody in the household has opened yet. */
export function unopened(db: Db, reader: Reader, exclude: Set<string>, limit: number, now: number): BookSummary[] {
  const opened = db
    .select({ x: sql`1` })
    .from(readingProgress)
    .innerJoin(users, eq(users.id, readingProgress.userId))
    .where(and(eq(readingProgress.bookId, books.id), eq(users.householdId, reader.householdId)));
  return pickRows(db, reader, [notExists(opened), eq(books.kindleOnly, false)], exclude, limit, [shuffled(now)]);
}

/** Short books (under 200 pages), for an evening. */
export function quickReads(db: Db, reader: Reader, exclude: Set<string>, limit: number, now: number): BookSummary[] {
  return pickRows(db, reader, [isNotNull(books.pageCount), lte(books.pageCount, 200), sql`${books.pageCount} > 20`], exclude, limit, [shuffled(now)]);
}

/**
 * Parent picks: for a kid, books picked for them or for their whole family; for grown-ups, the
 * family's picks. Filtered by the reader's own limit like everything else.
 */
export function parentPicks(db: Db, reader: Reader, exclude: Set<string>, limit: number): BookSummary[] {
  const family = reader.familyId
    ? inArray(books.id, db.select({ id: familyPicks.bookId }).from(familyPicks).where(eq(familyPicks.familyId, reader.familyId)))
    : undefined;
  const mine = reader.isKid ? inArray(books.id, db.select({ id: kidShelf.bookId }).from(kidShelf).where(eq(kidShelf.kidId, reader.userId))) : undefined;
  const any = [family, mine].filter((x): x is SQL => !!x);
  if (!any.length) return [];
  return pickRows(db, reader, [or(...any)], exclude, limit, [desc(books.addedAt)]);
}

/**
 * One book the reader may open and hasn't started, at random. `kidsOnly` keeps it to kids' ratings
 * (for a grown-up picking for a child). Null when there's nothing left.
 */
export function surprise(db: Db, reader: Reader, opts: { kidsOnly?: boolean; mood?: string } = {}): BookSummary | null {
  const started = db.select({ id: readingProgress.bookId }).from(readingProgress).where(eq(readingProgress.userId, reader.userId));
  const mood = opts.mood ? MOODS.find((m) => m.id === opts.mood) : undefined;
  const moodIds = mood ? tagIds(allTags(db), mood.match) : null;
  if (moodIds && !moodIds.length) return null;
  const row = db
    .select(SUMMARY)
    .from(books)
    .where(
      and(
        visibleBooksWhere(reader),
        notInArray(books.id, started),
        eq(books.kindleOnly, false),
        opts.kidsOnly ? inArray(books.rating, KIDS) : undefined,
        moodIds ? inArray(books.id, db.select({ id: bookTags.bookId }).from(bookTags).where(inArray(bookTags.tagId, moodIds))) : undefined,
      ),
    )
    .orderBy(sql`random()`)
    .limit(1)
    .get();
  return row ? enrich(db, reader, [row])[0]! : null;
}
