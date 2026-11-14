import type { BookFileRef, BookFormat } from "../api/types";

/** Formats the web reader opens itself. CBR and audio need server-side help. */
export const READABLE_FORMATS: BookFormat[] = ["epub", "azw3", "mobi", "fb2", "cbz", "pdf"];

/** Preference order when a book has several files. EPUB reflows best. */
const ORDER: BookFormat[] = ["epub", "azw3", "mobi", "fb2", "cbz", "pdf"];

export function pickReadableFile(files: BookFileRef[] | undefined): BookFileRef | null {
  if (!files?.length) return null;
  for (const f of ORDER) {
    const hit = files.find((x) => x.format === f);
    if (hit) return hit;
  }
  return null;
}
