/**
 * Pure helpers for the grown-up home page (HomePage.tsx): what goes in "Jump back in", which
 * series are worth continuing, and how the server's shelves are grouped into sections.
 */
import type { BookSummary, Shelf } from "../api/types";

export function greeting(hour: number): string {
  if (hour < 5) return "Up late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export interface ListeningLike {
  id: string;
  title: string;
  coverPath: string | null;
  progress: { percent: number; currentTime: number; duration: number };
}

/** One card in "Jump back in": a book being read, listened to, or both. */
export interface InProgress {
  book: Pick<BookSummary, "id" | "title" | "coverPath"> & Partial<BookSummary>;
  /** 0..1, the further of reading and listening */
  percent: number;
  reading: boolean;
  listening: boolean;
  /** Seconds left in the audiobook, when listening */
  secondsLeft: number | null;
}

/**
 * Reading comes first (the server orders it by most recent), then audiobooks the reader is only
 * listening to. A book that is both read and listened to shows once, with both buttons.
 */
export function jumpBackIn(reading: BookSummary[], listening: ListeningLike[], max = 6): InProgress[] {
  const byId = new Map<string, InProgress>();
  for (const b of reading) {
    byId.set(b.id, { book: b, percent: b.percent ?? 0, reading: true, listening: false, secondsLeft: null });
  }
  for (const l of listening) {
    const left = l.progress.duration ? Math.max(0, l.progress.duration - l.progress.currentTime) : null;
    const seen = byId.get(l.id);
    if (seen) {
      seen.listening = true;
      seen.secondsLeft = left;
      seen.percent = Math.max(seen.percent, l.progress.percent);
    } else {
      byId.set(l.id, {
        book: { id: l.id, title: l.title, coverPath: l.coverPath },
        percent: l.progress.percent,
        reading: false,
        listening: true,
        secondsLeft: left,
      });
    }
  }
  return [...byId.values()].slice(0, max);
}

export function timeLeft(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return "under a minute left";
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min left` : `${h} h left`;
}

export interface SeriesPick {
  id: string;
  name: string;
  total: number;
  books: BookSummary[];
  /** The book to open next: the one in progress, else the first unstarted one */
  next: BookSummary | null;
  started: boolean;
}

/**
 * "Series to continue": only series the reader has started that have more than one book, so
 * one-book "series" (often a publisher imprint) never fill the home page.
 */
export function seriesToContinue(shelves: Shelf[], inProgressIds: Set<string>, max = 8): SeriesPick[] {
  return shelves
    .filter((s) => s.kind === "series" && (s.total ?? s.books.length) > 1)
    .map((s) => {
      const current = s.books.find((b) => inProgressIds.has(b.id) || (b.percent != null && b.percent > 0 && b.percent < 1));
      const started = !!current || s.books.some((b) => (b.percent ?? 0) > 0);
      const next = current ?? s.books.find((b) => !b.percent) ?? null;
      return { id: s.id.replace(/^series:/, ""), name: s.name, total: s.total ?? s.books.length, books: s.books, next, started };
    })
    .filter((s) => s.started && s.next)
    .slice(0, max);
}

/** A row needs at least this many books to earn a place on the home page. */
export const MIN_ROW_BOOKS = 4;

/**
 * The rows that stay full-width shelves: household collections, and sections (like Cookbooks)
 * with enough books to fill a row.
 */
export function extraShelves(shelves: Shelf[]): Shelf[] {
  return shelves.filter(
    (s) => (s.kind === "collection" && s.books.length) || ((s.kind === "tag" || s.kind === "kid") && (s.total ?? s.books.length) >= MIN_ROW_BOOKS),
  );
}

const KID_RATINGS = new Set(["kids", "middle_grade"]);
export const isKidsBook = (b: Pick<BookSummary, "rating">) => b.rating != null && KID_RATINGS.has(b.rating);

/**
 * Splits the newest books by audience so picture books don't sit next to grown-up romance.
 * Unrated books count as grown-up, like the content lock.
 */
export function splitByAudience(books: BookSummary[], max = 20): { grownUp: BookSummary[]; kids: BookSummary[] } {
  return {
    grownUp: books.filter((b) => !isKidsBook(b)).slice(0, max),
    kids: books.filter(isKidsBook).slice(0, max),
  };
}

/**
 * Curated genres worth a full row on a grown-up's home: big enough, biggest first, and not
 * the kids' genres (those books get their own "New for the kids" row).
 */
export function genreRowCandidates<C extends { kind: string; bookCount: number; books: Pick<BookSummary, "rating">[] }>(
  categories: C[],
  max = 4,
): C[] {
  return categories
    .filter((c) => c.kind === "genre" && c.bookCount >= MIN_ROW_BOOKS)
    .filter((c) => !c.books.length || c.books.filter(isKidsBook).length * 2 <= c.books.length)
    .sort((a, b) => b.bookCount - a.bookCount)
    .slice(0, max);
}

export interface DeskItem {
  to: string;
  label: string;
  count?: number;
  icon: string;
}

/**
 * What's waiting on this person, by role: the admin's inbox and rating queue, approvals for
 * parents and admins, a grown-up's own open requests. Zero counts are left out.
 */
export function deskItems(
  role: string | undefined,
  overview: { inbox: number; unrated: number; pendingRequests: number } | null,
  requests: { open: number; toApprove: number } | null,
): DeskItem[] {
  const items: DeskItem[] = [];
  const manager = role === "admin" || role === "parent";
  if (role === "admin" && overview) {
    if (overview.inbox) items.push({ to: "/admin/inbox", label: "new in the inbox", count: overview.inbox, icon: "📥" });
    if (overview.unrated) items.push({ to: "/admin/review", label: "need a rating", count: overview.unrated, icon: "⭐" });
  }
  const toApprove = requests?.toApprove ?? overview?.pendingRequests ?? 0;
  if (manager && toApprove)
    items.push({ to: "/requests", label: toApprove === 1 ? "request to approve" : "requests to approve", count: toApprove, icon: "🙋" });
  if (!manager && requests?.open)
    items.push({ to: "/requests", label: requests.open === 1 ? "open request" : "open requests", count: requests.open, icon: "🙋" });
  if (manager) items.push({ to: "/family", label: "See how the kids are reading", icon: "👨‍👩‍👧" });
  return items;
}
