import type { ContentRating, ReadingLocator, Role, ThemeId } from "@bookbandit/shared";

/** GET /api/me */
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

/** GET /api/shelves: named rows on the home screen. */
export interface Shelf {
  id: string;
  name: string;
  kind: "continue" | "kid" | "recent" | "series" | "collection" | "tag";
  books: BookSummary[];
}

/** GET /api/progress/:bookId */
export interface ProgressRecord {
  bookId: string;
  locator: ReadingLocator;
  percent: number;
  finished: boolean;
  deviceName: string | null;
  /** ISO 8601, the client time of the device that wrote it */
  updatedAt: string;
}

export interface Bookmark {
  id: string;
  bookId: string;
  kind: "bookmark" | "highlight" | "sticker";
  locator: ReadingLocator;
  text: string | null;
  note: string | null;
  color: string | null;
  createdAt: number;
}

export type NewBookmark = Omit<Bookmark, "id" | "createdAt">;
