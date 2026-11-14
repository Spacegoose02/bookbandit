/** The text of one EPUB section (spine item), read on the server so a quiz uses the real chapter. */
import { join, posix } from "node:path";
import { htmlToText } from "../ai/booktext.js";
import { asArray, attrOf } from "../metadata/xml.js";
import { opfOf } from "../narration/overlays.js";

type Node = Record<string, unknown>;

/** Spine items as zip paths, in reading order. */
export function spinePaths(opf: Node, opfPath: string): string[] {
  const pkg = (opf.package ?? {}) as Node;
  const items = asArray((pkg.manifest as Node | undefined)?.item as Node | Node[] | undefined);
  const hrefs = new Map(items.map((i) => [attrOf(i, "id") ?? "", attrOf(i, "href") ?? ""]));
  const dir = posix.dirname(opfPath);
  return asArray((pkg.spine as Node | undefined)?.itemref as Node | Node[] | undefined)
    .map((r) => hrefs.get(attrOf(r, "idref") ?? ""))
    .filter((h): h is string => !!h)
    .map((h) => posix.normalize(dir === "." ? decodeURIComponent(h) : posix.join(dir, decodeURIComponent(h))));
}

/**
 * Text of the spine item `section` (a zip path as foliate-js reports it, e.g. "OEBPS/ch1.xhtml").
 * Only spine items can be read. null when the section isn't in the book.
 */
export async function sectionText(booksDir: string, relPath: string, section: string): Promise<string | null> {
  const book = await opfOf(join(booksDir, relPath));
  if (!book) return null;
  try {
    const wanted = posix.normalize(section.split("#")[0]!.replace(/^\/+/, ""));
    const spine = spinePaths(book.opf, book.opfPath);
    const name = spine.find((p) => p === wanted) ?? spine.find((p) => p.endsWith(`/${wanted}`));
    if (!name) return null;
    return htmlToText((await book.read(name)).toString("utf8"));
  } finally {
    book.close();
  }
}
