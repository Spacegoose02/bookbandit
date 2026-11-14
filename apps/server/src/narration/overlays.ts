/**
 * EPUB3 media overlays (read-along books with a recorded narrator). The web reader plays them
 * with foliate-js; the server only says whether a book has them, so the read-aloud button can
 * offer the real narrator before the synthetic voice.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { openZip } from "../metadata/zip.js";
import { asArray, attrOf, parseXml } from "../metadata/xml.js";

type Node = Record<string, unknown>;

const memo = new Map<string, boolean>();

export async function opfOf(path: string): Promise<{ opf: Node; opfPath: string; names: string[]; read: (n: string) => Promise<Buffer>; close: () => void } | null> {
  const zip = await openZip(path);
  try {
    const container = parseXml((await zip.read("META-INF/container.xml")).toString("utf8"));
    const rootfiles = asArray((container.container as Node | undefined)?.rootfiles as Node | Node[] | undefined) as Node[];
    const rootfile = asArray(rootfiles[0]?.rootfile as Node | Node[] | undefined)[0];
    const opfPath = attrOf(rootfile, "full-path") ?? zip.names.find((n) => n.toLowerCase().endsWith(".opf"));
    if (!opfPath) {
      zip.close();
      return null;
    }
    const opf = parseXml((await zip.read(opfPath)).toString("utf8"));
    return { opf, opfPath, names: zip.names, read: (n) => zip.read(n, 8 * 1024 * 1024), close: () => zip.close() };
  } catch (e) {
    zip.close();
    throw e;
  }
}

/** True when any manifest item points at a SMIL media overlay. */
export function opfHasMediaOverlay(opf: Node): boolean {
  const pkg = (opf.package ?? {}) as Node;
  const items = asArray((pkg.manifest as Node | undefined)?.item as Node | Node[] | undefined);
  const smil = new Set(items.filter((i) => attrOf(i, "media-type") === "application/smil+xml").map((i) => attrOf(i, "id")));
  return smil.size > 0 && items.some((i) => {
    const mo = attrOf(i, "media-overlay");
    return !!mo && smil.has(mo);
  });
}

export async function hasMediaOverlay(booksDir: string, relPath: string): Promise<boolean> {
  const abs = join(booksDir, relPath);
  const s = await stat(abs).catch(() => null);
  if (!s) return false;
  const key = `${abs}:${s.mtimeMs}:${s.size}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let result = false;
  try {
    const book = await opfOf(abs);
    if (book) {
      result = opfHasMediaOverlay(book.opf);
      book.close();
    }
  } catch {
    result = false;
  }
  memo.set(key, result);
  if (memo.size > 500) memo.delete(memo.keys().next().value!);
  return result;
}
