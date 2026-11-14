/** Small text helpers shared by metadata readers, matching and sorting. */

const LEADING_ARTICLES = /^(the|a|an)\s+/i;

/** "The Hobbit" → "hobbit, the" style sort key (lower-cased, article moved to the end). */
export function sortTitle(title: string): string {
  const t = title.trim();
  const m = t.match(LEADING_ARTICLES);
  const base = m ? `${t.slice(m[0].length)}, ${m[1]}` : t;
  return base.toLowerCase();
}

/** "J. R. R. Tolkien" → "Tolkien, J. R. R."; "Tolkien, J.R.R." is kept as is. */
export function authorSortName(name: string): string {
  const n = name.trim();
  if (n.includes(",")) return n;
  const parts = n.split(/\s+/);
  if (parts.length < 2) return n;
  const last = parts.pop()!;
  return `${last}, ${parts.join(" ")}`;
}

/** "Tolkien, J. R. R." → "J. R. R. Tolkien". Leaves "First Last" alone. */
export function authorDisplayName(name: string): string {
  const n = collapse(name);
  const m = n.match(/^([^,]+),\s*([^,]+)$/);
  // Only flip "Last, First" when it looks like a person (not "Smith, Jr." etc).
  if (m && !/^(jr|sr|ii|iii|iv)\.?$/i.test(m[2]!.trim())) return `${m[2]!.trim()} ${m[1]!.trim()}`;
  return n;
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Loose key for matching titles/authors across sources: lower case, letters and digits only. */
export function matchKey(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(LEADING_ARTICLES, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** Strip HTML tags from a description (EPUB/Google descriptions are often HTML). */
export function stripHtml(s: string): string {
  return collapse(
    s
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'"),
  );
}

export function yearFrom(s: string | number | undefined | null): number | undefined {
  if (s == null) return undefined;
  const m = String(s).match(/\b(1[5-9]\d\d|20\d\d)\b/);
  return m ? Number(m[1]) : undefined;
}
