/**
 * Book text for spoiler-free chat: only what comes before the reader's position.
 * EPUB (spine order) and TXT are supported; other formats fall back to the description.
 */
import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { openZip } from "../metadata/zip.js";
import { asArray, attrOf, parseXml } from "../metadata/xml.js";

type Node = Record<string, unknown>;

export interface TextExcerpt {
  /** Start of the book, so names and setting are known. Empty when it overlaps `recent`. */
  opening: string;
  /** The text just before the reader's position. */
  recent: string;
  /** 0..1 position the excerpt stops at. */
  upTo: number;
}

const cache = new Map<string, string>();
const CACHE_MAX = 8;

export function htmlToText(html: string): string {
  return html
    .replace(/<(head|script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#?\w+;/g, " ")
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export async function epubText(path: string): Promise<string> {
  const zip = await openZip(path);
  try {
    const container = parseXml((await zip.read("META-INF/container.xml")).toString("utf8"));
    const rootfiles = asArray((container.container as Node | undefined)?.rootfiles as Node | Node[] | undefined) as Node[];
    const rootfile = asArray(rootfiles[0]?.rootfile as Node | Node[] | undefined)[0];
    const opfPath = attrOf(rootfile, "full-path") ?? zip.names.find((n) => n.toLowerCase().endsWith(".opf"));
    if (!opfPath) return "";
    const opf = parseXml((await zip.read(opfPath)).toString("utf8"));
    const pkg = (opf.package ?? {}) as Node;
    const items = asArray((pkg.manifest as Node | undefined)?.item as Node | Node[] | undefined);
    const hrefs = new Map(items.map((i) => [attrOf(i, "id") ?? "", attrOf(i, "href") ?? ""]));
    const spine = asArray((pkg.spine as Node | undefined)?.itemref as Node | Node[] | undefined);
    const dir = posix.dirname(opfPath);
    const parts: string[] = [];
    let total = 0;
    for (const ref of spine) {
      const href = hrefs.get(attrOf(ref, "idref") ?? "");
      if (!href) continue;
      const name = posix.normalize(dir === "." ? decodeURIComponent(href) : posix.join(dir, decodeURIComponent(href)));
      try {
        const t = htmlToText((await zip.read(name, 8 * 1024 * 1024)).toString("utf8"));
        if (t) parts.push(t);
        total += t.length;
      } catch {
        /* missing or huge chapter: skip */
      }
      if (total > 8_000_000) break;
    }
    return parts.join("\n\n");
  } finally {
    zip.close();
  }
}

async function fullText(booksDir: string, relPath: string, format: string): Promise<string | null> {
  const abs = join(booksDir, relPath);
  const s = await stat(abs).catch(() => null);
  if (!s) return null;
  const key = `${abs}:${s.mtimeMs}:${s.size}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let text: string;
  if (format === "epub" || format === "kepub") text = await epubText(abs);
  else if (format === "txt") text = s.size > 20_000_000 ? "" : (await readFile(abs, "utf8")).replace(/\r\n/g, "\n");
  else return null;
  cache.set(key, text);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return text;
}

/** Cuts the text at `percent` and keeps the opening plus the most recent part, within `budget` characters. */
export function excerptUpTo(text: string, percent: number, budget = 24_000): TextExcerpt {
  const upTo = Math.min(1, Math.max(0, percent));
  const end = Math.floor(text.length * upTo);
  const before = text.slice(0, end);
  if (before.length <= budget) return { opening: "", recent: before, upTo };
  const openingLen = Math.min(4_000, Math.floor(budget / 6));
  return { opening: before.slice(0, openingLen), recent: before.slice(before.length - (budget - openingLen)), upTo };
}

export async function readTextUpTo(
  booksDir: string,
  files: { relPath: string; format: string }[],
  percent: number,
  budget?: number,
): Promise<TextExcerpt | null> {
  const order = ["epub", "kepub", "txt"];
  const file = [...files].filter((f) => order.includes(f.format)).sort((a, b) => order.indexOf(a.format) - order.indexOf(b.format))[0];
  if (!file) return null;
  const text = await fullText(booksDir, file.relPath, file.format).catch(() => null);
  if (!text) return null;
  return excerptUpTo(text, percent, budget);
}

/** The first `chars` characters of the book's text (for the rating helper). */
export async function openingText(booksDir: string, files: { relPath: string; format: string }[], chars: number): Promise<string | null> {
  const ex = await readTextUpTo(booksDir, files, 1, Number.MAX_SAFE_INTEGER).catch(() => null);
  return ex ? ex.recent.slice(0, chars) : null;
}
