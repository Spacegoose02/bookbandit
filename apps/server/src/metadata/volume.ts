/**
 * Series volumes written into titles and file names: "Book 6", "(Book 6)", "Vol. 3", "#2",
 * "Volume Two". Used on import (so "Diary of a Wimpy Villager (Book 6)" gets a series and a book
 * number) and by every duplicate matcher (so Book 4 and Book 6 are never offered as copies).
 */
import { collapse, matchKey } from "./text.js";

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};
const NUM = `(\\d+(?:\\.\\d+)?|${Object.keys(WORDS).join("|")})`;
/** "book", "bk.", "vol.", "volume", "part", "tome", followed by a number. Not "books 1-3" (omnibus). */
const MARKER = `(?:book|bk|vol|volume|part|tome)\\.?\\s*#?\\s*${NUM}(?![a-z0-9])`;
const MARKED = new RegExp(`(?:^|[^a-z0-9])${MARKER}`, "i");
const HASHED = /(?:^|[\s(])#\s*(\d+(?:\.\d+)?)(?![\d])/;

const toNumber = (s: string): number | undefined => {
  const n = WORDS[s.toLowerCase()] ?? Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/** The volume number written in a title or name, if any. */
export function volumeIn(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const t = text.replace(/_/g, " ");
  const m = t.match(MARKED) ?? t.match(HASHED);
  return m ? toNumber(m[1]!) : undefined;
}

/** The volume from a file path: the file name first, then its folder (Calibre truncates file names). */
export function volumeFromPath(relPath: string): number | undefined {
  const parts = relPath.split("/").filter(Boolean);
  const file = (parts.pop() ?? "").replace(/\.[^.]+$/, "");
  return volumeIn(file) ?? volumeIn(parts.pop());
}

export interface SeriesInTitle {
  /** The title without a "(Series #N)" note; unchanged when the volume is part of the title. */
  title: string;
  series?: string;
  position?: number;
  /** Text after a mid-title volume, e.g. "An unofficial Minecraft book". */
  subtitle?: string;
}

/**
 * Splits series facts out of a title:
 * - "The Sea of Monsters (Percy Jackson #2)" → title "The Sea of Monsters", series "Percy Jackson", 2
 * - "Diary of a Wimpy Villager (Book 6): (An unofficial Minecraft book)" → series "Diary of a Wimpy
 *   Villager", 6, title "Diary of a Wimpy Villager, Book 6", subtitle "An unofficial Minecraft book"
 * - "Diary of a Wimpy Villager: Book 4", "Dog Man #1", "Naruto Vol. 3" → title kept, series and number set
 */
export function seriesInTitle(raw: string): SeriesInTitle {
  const title = collapse(raw);
  // "(Series Name #2)", "(Series Name, Book 2)", "(Series Name Vol. 2)"
  const note = title.match(new RegExp(`^(.+?)\\s*\\(([^()]*?[a-z][^()]*?)(?:\\s*#\\s*|,?\\s+(?:book|bk|vol|volume|part)\\.?\\s*#?\\s*)${NUM}\\)\\s*$`, "i"));
  if (note && !/^(?:book|bk|vol|volume|part)$/i.test(note[2]!.trim())) {
    const position = toNumber(note[3]!);
    return { title: collapse(note[1]!), series: tidySeries(note[2]!), position };
  }
  // "Name (Book 6): (subtitle)" or "Name (Book 6) - subtitle": the volume sits mid-title.
  const mid = title.match(new RegExp(`^(.+?)\\s*\\(\\s*${MARKER}\\s*\\)\\s*[:\\-–—]?\\s*(.*)$`, "i"));
  if (mid) {
    const series = tidySeries(mid[1]!);
    const position = toNumber(mid[2]!);
    const rest = collapse(mid[3]!.replace(/^\((.*)\)$/, "$1"));
    return { title: series && position != null ? `${series}, Book ${position}` : title, series, position, ...(rest ? { subtitle: rest } : {}) };
  }
  // Trailing "…: Book 4", "…, Vol. 3", "… Book Two", "… #1"
  const tail = title.match(new RegExp(`^(.+?)[\\s,:;\\-–—(]+${MARKER}\\)?\\s*$`, "i")) ?? title.match(/^(.+?)\s*#\s*(\d+(?:\.\d+)?)\s*$/);
  if (tail) {
    const series = tidySeries(tail[1]!);
    return { title, series, position: toNumber(tail[2]!) };
  }
  return { title };
}

function tidySeries(s: string): string | undefined {
  const t = collapse(s.replace(/[\s,:;\-–—(]+$/, ""));
  return t.length >= 2 ? t : undefined;
}

/**
 * Fills series and book number from the title or the path when the file's own metadata left them
 * out, and gives a volume-less title its number ("Diary of a Wimpy Villager" from an EPUB whose
 * folder says "(Book 6)" becomes "Diary of a Wimpy Villager, Book 6").
 */
export function withVolume<T extends { title?: string; subtitle?: string; series?: string; seriesPosition?: number }>(meta: T, pathVolume?: number): T {
  const out = { ...meta };
  if (out.title) {
    const s = seriesInTitle(out.title);
    out.title = s.title;
    if (!out.series && s.series) out.series = s.series;
    if (out.seriesPosition == null && s.position != null) out.seriesPosition = s.position;
    if (!out.subtitle && s.subtitle) out.subtitle = s.subtitle;
  }
  if (out.seriesPosition == null && pathVolume != null) out.seriesPosition = pathVolume;
  if (out.title && out.seriesPosition != null && volumeIn(out.title) == null) {
    // The title names the series rather than this volume: say which book it is.
    if (!out.series || namesSeries(out.title, out.series)) {
      out.series ??= out.title;
      out.title = `${out.title}, Book ${out.seriesPosition}`;
    }
  }
  return out;
}

/** "Minecraft: Diary of a Wimpy Villager" names the series "Diary of a Wimpy Villager"; "Goblet of Fire" doesn't name "Harry Potter". */
function namesSeries(title: string, series: string): boolean {
  const t = matchKey(title);
  const s = matchKey(series);
  return t === s || (s.length >= 8 && t.endsWith(s));
}

/** What tells two records of one title apart: their book number and ISBN. */
export interface WorkFacts {
  volume?: number | null;
  isbn13?: string | null;
}

/** True when two records can't be the same book: different book numbers, or (unless `ignoreIsbn`) different ISBNs. */
export function differentBooks(a: WorkFacts, b: WorkFacts, opts: { ignoreIsbn?: boolean } = {}): boolean {
  if (a.volume != null && b.volume != null && a.volume !== b.volume) return true;
  if (!opts.ignoreIsbn && a.isbn13 && b.isbn13 && a.isbn13 !== b.isbn13) return true;
  return false;
}

/** A book's number: its series position, else one written in its title, else in a file name. */
export function bookVolume(position: number | null | undefined, title: string, relPaths: string[] = []): number | undefined {
  if (position != null) return position;
  const fromTitle = volumeIn(title);
  if (fromTitle != null) return fromTitle;
  for (const p of relPaths) {
    const v = volumeFromPath(p);
    if (v != null) return v;
  }
  return undefined;
}
