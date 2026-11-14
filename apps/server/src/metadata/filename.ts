/**
 * Best-effort metadata from a file's path, used when the file itself has none.
 * Understands Calibre's "Author/Title (id)/Title - Author.ext" layout, "Author/Title.ext",
 * "Author - Title.ext" and "Title (Series #2)" styles.
 */
import { posix } from "node:path";
import type { BookMetadata } from "./types.js";
import { authorDisplayName, collapse } from "./text.js";
import { findIsbn } from "./isbn.js";

export function metadataFromPath(relPath: string, ignoreDirs: ReadonlySet<string> = new Set()): BookMetadata {
  const parts = relPath.split("/").filter(Boolean);
  const file = parts.pop() ?? relPath;
  const dirs = parts.filter((d) => !ignoreDirs.has(d.toLowerCase()) && !d.startsWith("."));
  let stem = file.replace(/\.[^.]+$/, "");
  const out: BookMetadata = {};

  const isbn = findIsbn(stem);
  if (isbn) out.isbn13 = isbn;

  // Drop release-group noise: [retail], (epub), {ISBN}, underscores.
  stem = collapse(
    stem
      .replace(/_/g, " ")
      .replace(/\[[^\]]*\]|\{[^}]*\}/g, " ")
      .replace(/\((?:retail|epub|pdf|cbz|ebook|v\d+(?:\.\d+)?)\)/gi, " "),
  );

  // Series hint: "Title (Series Name #3)" or "(Series Name, Book 3)"
  const seriesMatch = stem.match(/\(([^()]+?)(?:\s*#|,?\s+book\s+)(\d+(?:\.\d+)?)\)/i);
  if (seriesMatch) {
    out.series = collapse(seriesMatch[1]!);
    out.seriesPosition = Number(seriesMatch[2]);
    stem = collapse(stem.replace(seriesMatch[0], " "));
  }

  const parent = dirs[dirs.length - 1];
  const grandparent = dirs[dirs.length - 2];

  // Calibre library: Author/Title (123)/file
  if (parent && grandparent && /\(\d+\)$/.test(parent)) {
    out.title = collapse(parent.replace(/\(\d+\)$/, ""));
    out.authors = [authorDisplayName(grandparent)];
    return out;
  }

  const dash = stem.split(/\s+-\s+/);
  if (dash.length >= 2) {
    const [a, ...rest] = dash;
    const b = rest.join(" - ");
    // If one side matches the folder name, that side is the author.
    if (parent && sameName(parent, b!)) {
      out.title = a!;
      out.authors = [authorDisplayName(b!)];
    } else {
      out.title = b!;
      out.authors = [authorDisplayName(a!)];
    }
    return out;
  }

  out.title = stem.replace(/\s*\(\d+\)$/, "") || file;
  if (parent) out.authors = [authorDisplayName(parent)];
  return out;
}

function sameName(a: string, b: string): boolean {
  const k = (s: string) => authorDisplayName(s).toLowerCase().replace(/[^a-z]/g, "");
  return k(a) === k(b);
}
