import { matchKey } from "../text.js";

/** Does a search hit plausibly describe the book we asked about? Guards title/author searches. */
export function plausibleMatch(
  want: { title?: string; authors?: string[] },
  got: { title?: string; authors?: string[] },
): boolean {
  if (!want.title || !got.title) return false;
  const a = matchKey(want.title);
  const b = matchKey(got.title);
  if (!a || !b) return false;
  const titleOk = a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b));
  if (!titleOk) return false;
  if (!want.authors?.length || !got.authors?.length) return true;
  const surname = (n: string) => matchKey(n.split(/\s+/).pop() ?? n);
  const wanted = new Set(want.authors.map(surname));
  return got.authors.some((n) => wanted.has(surname(n)));
}
