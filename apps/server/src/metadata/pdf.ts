/** PDF metadata from the document Info dictionary. No cover rendering (the web reader renders page 1). */
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import type { FileMetadata } from "./types.js";
import { authorDisplayName, collapse } from "./text.js";
import { findIsbn } from "./isbn.js";

/** Files bigger than this are skipped (metadata falls back to the filename). */
const MAX_PDF_BYTES = 300 * 1024 * 1024;

export async function readPdf(path: string, sizeBytes: number): Promise<FileMetadata> {
  if (sizeBytes > MAX_PDF_BYTES) return {};
  const doc = await PDFDocument.load(await readFile(path), {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
  const out: FileMetadata = {};
  const title = doc.getTitle();
  // Many PDFs have junk titles like "Microsoft Word - draft3.doc" or "untitled".
  if (title && !/^(untitled|microsoft word|document\d*$)/i.test(title.trim()) && !/\.(docx?|pdf|indd)$/i.test(title.trim())) {
    out.title = collapse(title);
  }
  const author = doc.getAuthor();
  if (author) {
    const authors = author.split(/;|&| and /).map((a) => collapse(a)).filter(Boolean);
    if (authors.length) out.authors = authors.map(authorDisplayName);
  }
  const subject = doc.getSubject();
  if (subject) {
    out.description = collapse(subject);
    out.isbn13 = findIsbn(subject);
  }
  const keywords = doc.getKeywords();
  if (keywords) {
    const subjects = keywords.split(/[,;]/).map((k) => collapse(k)).filter(Boolean);
    if (subjects.length) out.subjects = subjects;
  }
  out.pageCount = doc.getPageCount();
  return out;
}
