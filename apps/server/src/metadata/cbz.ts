/** CBZ (zipped comics): ComicInfo.xml metadata, first image as cover. */
import type { FileMetadata } from "./types.js";
import { openZip } from "./zip.js";
import { parseXml, textOf } from "./xml.js";
import { toIsbn13 } from "./isbn.js";
import { authorDisplayName, collapse, stripHtml } from "./text.js";

const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export async function readCbz(path: string): Promise<FileMetadata> {
  const zip = await openZip(path);
  try {
    const out: FileMetadata = {};
    const images = zip.names
      .filter((n) => IMAGE.test(n) && !n.startsWith("__MACOSX/") && !/(^|\/)\./.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (images.length) out.pageCount = images.length;

    const infoName = zip.names.find((n) => n.split("/").pop()!.toLowerCase() === "comicinfo.xml");
    if (infoName) {
      const doc = parseXml((await zip.read(infoName, 2 * 1024 * 1024)).toString("utf8"));
      const ci = (doc.ComicInfo ?? {}) as Record<string, unknown>;
      const t = (k: string) => {
        const v = textOf(ci[k]);
        return v ? collapse(v) : undefined;
      };
      out.series = t("Series");
      const num = Number(t("Number"));
      if (out.series && Number.isFinite(num)) out.seriesPosition = num;
      out.title = t("Title") ?? (out.series ? `${out.series}${t("Number") ? ` #${t("Number")}` : ""}` : undefined);
      const writers = (t("Writer") ?? "").split(/[,;]/).map((s) => collapse(s)).filter(Boolean);
      if (writers.length) out.authors = writers.map(authorDisplayName);
      const summary = t("Summary");
      if (summary) out.description = stripHtml(summary);
      out.publisher = t("Publisher");
      const year = Number(t("Year"));
      if (Number.isInteger(year) && year > 1000) out.publishedYear = year;
      out.language = t("LanguageISO")?.toLowerCase();
      const genres = (t("Genre") ?? "").split(/[,;]/).map((s) => collapse(s)).filter(Boolean);
      const tags = (t("Tags") ?? "").split(/[,;]/).map((s) => collapse(s)).filter(Boolean);
      if (genres.length || tags.length) out.subjects = [...genres, ...tags];
      out.ageRating = t("AgeRating");
      out.isbn13 = toIsbn13(t("GTIN"));
      const pages = Number(t("PageCount"));
      if (Number.isInteger(pages) && pages > 0) out.pageCount = pages;
    }

    const first = images[0];
    if (first) {
      try {
        const ext = first.split(".").pop()!.toLowerCase();
        out.cover = { data: await zip.read(first, 15 * 1024 * 1024), mime: MIME[ext] ?? "image/jpeg" };
      } catch {
        // ignore unreadable cover
      }
    }
    return out;
  } finally {
    zip.close();
  }
}
