/**
 * Reads one recipe out of a cookbook EPUB that Cook mode already has open: from the recipe's
 * table-of-contents anchor up to the next recipe's anchor in the same file (or the file's end),
 * as headings, paragraphs and list items. The server sorts them into ingredients and steps.
 */
import type { FoliateView } from "foliate-js/view.js";
import type { RecipeBlock } from "./api";

interface Section {
  createDocument(): Promise<Document>;
}
interface BookWithSections {
  sections?: Section[];
  resolveHref?(href: string): { index: number; anchor: (doc: Document) => Element | Range | number | null } | null;
}

const MAX_BLOCKS = 400;

/** The file part and the fragment of a table-of-contents href. */
export function splitHref(href: string): { path: string; id: string | null } {
  const i = href.indexOf("#");
  return i < 0 ? { path: href, id: null } : { path: href.slice(0, i), id: decodeURIComponent(href.slice(i + 1)) || null };
}

/** The next recipe that starts later in the same file, where this one ends. */
export function nextInSameFile(hrefs: string[], href: string): string | null {
  const at = hrefs.indexOf(href);
  const { path } = splitHref(href);
  for (const h of hrefs.slice(at + 1)) {
    const s = splitHref(h);
    if (s.path !== path) return null;
    if (s.id) return h;
  }
  return null;
}

function blockOf(el: Element): RecipeBlock | null {
  const tag = el.tagName.toLowerCase();
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/^h[1-6]$/.test(tag)) return { type: "heading", text };
  if (tag === "li") {
    const list = el.closest("ol, ul");
    return { type: "item", text, list: list?.tagName.toLowerCase() === "ol" ? "ol" : "ul" };
  }
  if (tag === "p" || tag === "dd" || tag === "dt") {
    // A paragraph inside a list item is part of that item.
    if (el.closest("li")) return null;
    // Some books mark headings up as bold paragraphs.
    const strong = el.children.length === 1 && /^(b|strong)$/i.test(el.children[0]!.tagName) && el.children[0]!.textContent?.trim() === text;
    return { type: strong && text.length < 60 ? "heading" : "text", text };
  }
  return null;
}

const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
const CONTAINS = 16; // Node.DOCUMENT_POSITION_CONTAINED_BY

/** Blocks from `start` (inclusive) up to `end` (exclusive) in document order. */
export function blocksBetween(doc: Document, start: Element | null, end: Element | null): RecipeBlock[] {
  const out: RecipeBlock[] = [];
  const all = doc.body?.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, dt, dd") ?? [];
  for (const el of Array.from(all)) {
    if (start && el !== start && !(start.compareDocumentPosition(el) & (FOLLOWING | CONTAINS))) continue;
    if (end && (el === end || end.compareDocumentPosition(el) & (FOLLOWING | CONTAINS))) break;
    const b = blockOf(el);
    if (b) out.push(b);
    if (out.length >= MAX_BLOCKS) break;
  }
  return out;
}

/** The blocks of the recipe at `href`, given every recipe href in table-of-contents order. */
export async function recipeBlocks(view: FoliateView, hrefs: string[], href: string): Promise<RecipeBlock[]> {
  const book = view.book as unknown as BookWithSections | null;
  const target = book?.resolveHref?.(href);
  const section = target ? book?.sections?.[target.index] : undefined;
  if (!target || !section) return [];
  const doc = await section.createDocument();
  const startId = splitHref(href).id;
  const next = nextInSameFile(hrefs, href);
  const endId = next ? splitHref(next).id : null;
  const byId = (id: string | null) => (id ? doc.getElementById(id) ?? doc.querySelector(`[name="${CSS.escape(id)}"]`) : null);
  return blocksBetween(doc, byId(startId), byId(endId));
}
