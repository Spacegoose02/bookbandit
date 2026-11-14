/** ISBN helpers. We store ISBN-13 only; ISBN-10s are converted. */

function isbn13Check(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

function validIsbn10(s: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = s[i]!;
    const v = c === "X" ? 10 : Number(c);
    if (Number.isNaN(v) || (c === "X" && i !== 9)) return false;
    sum += v * (10 - i);
  }
  return sum % 11 === 0;
}

/** Returns a valid ISBN-13 for any valid ISBN-10/13 written with or without dashes, else undefined. */
export function toIsbn13(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const s = raw.toUpperCase().replace(/^(URN:)?ISBN:?/, "").replace(/[^0-9X]/g, "");
  if (s.length === 13 && /^\d{13}$/.test(s) && (s.startsWith("978") || s.startsWith("979"))) {
    return isbn13Check(s.slice(0, 12)) === s[12] ? s : undefined;
  }
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s) && validIsbn10(s)) {
    const first12 = `978${s.slice(0, 9)}`;
    return first12 + isbn13Check(first12);
  }
  return undefined;
}

/** First valid ISBN found anywhere in a block of text. */
export function findIsbn(text: string): string | undefined {
  for (const m of text.matchAll(/(?:97[89][-\s]?)?(?:\d[-\s]?){9}[\dXx]/g)) {
    const isbn = toIsbn13(m[0]);
    if (isbn) return isbn;
  }
  return undefined;
}
