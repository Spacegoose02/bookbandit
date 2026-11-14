import type { BookmarkKind, BookmarkRecord, ContentRating, ProgressRecord, ReadingLocator, Role, ThemeId } from "@bookbandit/shared";

export type { ProgressRecord };
export type Bookmark = BookmarkRecord;

/** The signed-in reader, derived from GET /api/users/me (see `toMe` in client.ts). */
export interface Me {
  id: string;
  displayName: string;
  role: Role;
  isKid: boolean;
  avatar: string | null;
  theme: ThemeId;
  /** Highest rating the server will show this reader. The UI only uses it to trim filter options. */
  maxRating: ContentRating;
}

export interface AuthorRef {
  id: string;
  name: string;
}

export interface SeriesRef {
  id: string;
  name: string;
  /** Position in the series, e.g. 1, 2, 2.5 */
  position: number | null;
}

/** One row of GET /api/books */
export interface BookSummary {
  id: string;
  title: string;
  publishedYear: number | null;
  rating: ContentRating | null;
  coverPath: string | null;
  kindleOnly: boolean;
  authors?: AuthorRef[];
  series?: SeriesRef[];
  /** 0..1, present when the reader has started it */
  percent?: number | null;
}

export type BookFormat = "epub" | "pdf" | "cbz" | "cbr" | "mobi" | "azw3" | "fb2" | "m4b" | "mp3";

export interface BookFileRef {
  id: string;
  format: BookFormat;
  sizeBytes: number;
}

/** GET /api/books/:id */
export interface BookDetail extends BookSummary {
  subtitle: string | null;
  description: string | null;
  language: string | null;
  publisher: string | null;
  pageCount: number | null;
  kindleAsin: string | null;
  absItemId: string | null;
  files?: BookFileRef[];
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  total?: number;
}

/** GET /api/shelves: named rows on the home screen. The id also works as `?shelf=` on /api/books. */
export interface Shelf {
  id: string;
  name: string;
  kind: "continue" | "kid" | "recent" | "series" | "collection" | "tag";
  /** How many books the whole shelf has (books holds the first few) */
  total?: number;
  books: BookSummary[];
}

/** POST /api/bookmarks. Send our own UUID so a retry (or an offline upload) can't duplicate it. */
export interface NewBookmark {
  id?: string;
  bookId: string;
  kind: BookmarkKind;
  locator: ReadingLocator;
  text: string | null;
  note: string | null;
  color: string | null;
}

/** Reply to PUT /api/progress/:bookId. On "stale" the server already had a newer position. */
export interface ProgressPutResult {
  bookId: string;
  status: "applied" | "stale";
  progress: ProgressRecord;
}

/** Reply to POST /api/progress/batch */
export interface ProgressBatchResult {
  results: ({ bookId: string; status: "applied" | "stale"; progress: ProgressRecord } | { bookId: string; status: "not_found" })[];
}

