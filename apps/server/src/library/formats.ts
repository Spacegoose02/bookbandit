import { BOOK_FORMATS } from "../db/schema.js";

export type BookFormat = (typeof BOOK_FORMATS)[number];

const BY_EXTENSION: Record<string, BookFormat> = {
  epub: "epub",
  kepub: "kepub",
  mobi: "mobi",
  azw: "azw3",
  azw3: "azw3",
  fb2: "fb2",
  pdf: "pdf",
  cbz: "cbz",
  cbr: "cbr",
  txt: "txt",
};

/** Format for a file name, or undefined when it isn't a book. Handles "x.kepub.epub". */
export function formatForPath(relPath: string): BookFormat | undefined {
  const lower = relPath.toLowerCase();
  if (lower.endsWith(".kepub.epub")) return "kepub";
  const ext = lower.split(".").pop() ?? "";
  return BY_EXTENSION[ext];
}
