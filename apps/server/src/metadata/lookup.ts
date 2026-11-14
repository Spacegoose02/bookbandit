/**
 * Online metadata lookup across Hardcover, Google Books, ISBNdb (with a key) and Open Library.
 * ISBN first; falls back to title + author with a plausibility check so a search
 * never attaches some other book's metadata (or rating) to a file.
 */
import type { BookMetadata, ProviderMatch } from "./types.js";
import type { FetchLike } from "./providers/http.js";
import { searchOpenLibrary } from "./providers/openlibrary.js";
import { searchGoogleBooks } from "./providers/google.js";
import { searchHardcover } from "./providers/hardcover.js";
import { searchIsbndb } from "./providers/isbndb.js";
import { mergeMetadata } from "./extract.js";

export interface LookupOptions {
  fetch?: FetchLike;
  googleApiKey?: string;
  hardcoverToken?: string;
  /** ISBNdb (paid, optional). */
  isbndbKey?: string;
}

export interface LookupResult {
  matches: ProviderMatch[];
  /** Provider failures (network, quota). Lookup still returns what the others found. */
  errors: string[];
}

export async function lookupOnline(want: BookMetadata, opts: LookupOptions = {}): Promise<LookupResult> {
  const fetchFn = opts.fetch ?? fetch;
  const tasks: Promise<ProviderMatch | undefined>[] = [];
  const names: string[] = [];
  if (opts.hardcoverToken) {
    names.push("hardcover");
    tasks.push(searchHardcover(fetchFn, want, opts.hardcoverToken));
  }
  if (opts.isbndbKey) {
    names.push("isbndb");
    tasks.push(searchIsbndb(fetchFn, want, opts.isbndbKey));
  }
  names.push("google");
  tasks.push(searchGoogleBooks(fetchFn, want, opts.googleApiKey));
  names.push("openlibrary");
  tasks.push(searchOpenLibrary(fetchFn, want));

  const settled = await Promise.allSettled(tasks);
  const matches: ProviderMatch[] = [];
  const errors: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      if (s.value) matches.push(s.value);
    } else {
      errors.push(`${names[i]}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
    }
  });

  // An ISBN-less search may discover the ISBN; one more pass by ISBN finds providers that missed.
  if (!want.isbn13) {
    const isbn = matches.find((m) => m.isbn13)?.isbn13;
    if (isbn) {
      const missing = new Set(names.filter((n) => !matches.some((m) => m.provider === n)));
      if (missing.size) {
        const again = await lookupOnline({ ...want, isbn13: isbn }, opts);
        matches.push(...again.matches.filter((m) => missing.has(m.provider)));
      }
    }
  }
  return { matches, errors };
}

/**
 * Combine what the file says with provider matches. The file wins for title/authors/series
 * (the owner may have fixed them in Calibre); providers fill the gaps, Hardcover first.
 * Subjects and content warnings are unioned because the rating rules want every signal.
 */
export function combineMetadata(file: BookMetadata, matches: ProviderMatch[]): BookMetadata {
  const order = ["hardcover", "google", "isbndb", "openlibrary"] as const;
  const sorted = [...matches].sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
  let out: BookMetadata = { ...file };
  for (const m of sorted) {
    const { provider: _p, providerId: _id, coverUrl: _c, maturityRating: _mr, subjects: _s, contentWarnings: _w, ...rest } = m;
    out = mergeMetadata(out, rest);
  }
  const subjects = new Set([...(file.subjects ?? []), ...sorted.flatMap((m) => m.subjects ?? [])]);
  if (subjects.size) out.subjects = [...subjects];
  const warnings = new Set([...(file.contentWarnings ?? []), ...sorted.flatMap((m) => m.contentWarnings ?? [])]);
  if (warnings.size) out.contentWarnings = [...warnings];
  return out;
}
