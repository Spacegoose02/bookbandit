/**
 * Translating reading positions between the web reader (EPUB CFI), KOReader (crengine
 * XPointer) and Kobo (spine file + KoboSpan).
 *
 * All three agree on which spine item (chapter file) the reader is in, so that part is exact.
 * Inside a chapter, KOReader and CFI both name an element path, so we translate it element by
 * element against the chapter's XHTML (character offsets are dropped: you land on the right
 * paragraph). Kobo spans only exist in the KEPUB the device renders, so for Kobo we go to the
 * start of the chapter and rely on the percentage for the rest.
 */
import { posix } from "node:path";
import { stat } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { openZip, type ZipReader } from "../metadata/zip.js";

type OrderedNode = Record<string, unknown>;

const ordered = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  htmlEntities: false,
  trimValues: false,
});

function parseOrdered(text: string): OrderedNode[] {
  const cleaned = text.replace(/^﻿/, "").replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, "");
  return ordered.parse(cleaned) as OrderedNode[];
}

interface El {
  name: string;
  attrs: Record<string, string>;
  children: OrderedNode[];
}

function asElement(node: OrderedNode): El | null {
  for (const key of Object.keys(node)) {
    if (key === ":@" || key.startsWith("#") || key.startsWith("?")) continue;
    return {
      name: key.toLowerCase(),
      attrs: (node[":@"] as Record<string, string> | undefined) ?? {},
      children: (node[key] as OrderedNode[] | undefined) ?? [],
    };
  }
  return null;
}

function elementChildren(nodes: OrderedNode[]): El[] {
  const out: El[] = [];
  for (const n of nodes) {
    const el = asElement(n);
    if (el) out.push(el);
  }
  return out;
}

function findChild(nodes: OrderedNode[], name: string): { el: El; index: number } | null {
  const kids = elementChildren(nodes);
  const index = kids.findIndex((k) => k.name === name);
  return index < 0 ? null : { el: kids[index]!, index };
}

export interface Spine {
  /** CFI step of <spine> inside <package> (almost always 6). */
  packageStep: number;
  /** Zip paths of the spine items, in reading order. */
  items: string[];
}

const spineCache = new Map<string, Spine>();
const SPINE_CACHE_MAX = 200;

async function withZip<T>(abs: string, fn: (zip: ZipReader) => Promise<T>): Promise<T> {
  const zip = await openZip(abs);
  try {
    return await fn(zip);
  } finally {
    zip.close();
  }
}

async function opfPathOf(zip: ZipReader): Promise<string> {
  const container = parseOrdered((await zip.read("META-INF/container.xml")).toString("utf8"));
  const find = (nodes: OrderedNode[]): string | undefined => {
    for (const el of elementChildren(nodes)) {
      if (el.name === "rootfile" && el.attrs["full-path"]) return el.attrs["full-path"];
      const inner = find(el.children);
      if (inner) return inner;
    }
    return undefined;
  };
  const path = find(container) ?? zip.names.find((n) => n.toLowerCase().endsWith(".opf"));
  if (!path) throw new Error("EPUB has no OPF package document");
  return path;
}

async function readSpineFromZip(zip: ZipReader): Promise<Spine> {
  const opfPath = await opfPathOf(zip);
  const pkg = findChild(parseOrdered((await zip.read(opfPath)).toString("utf8")), "package");
  if (!pkg) throw new Error("OPF has no package");
  const manifest = findChild(pkg.el.children, "manifest");
  const spine = findChild(pkg.el.children, "spine");
  if (!manifest || !spine) throw new Error("OPF has no manifest or spine");
  const hrefs = new Map<string, string>();
  for (const item of elementChildren(manifest.el.children)) {
    if (item.name === "item" && item.attrs.id && item.attrs.href) hrefs.set(item.attrs.id, item.attrs.href);
  }
  const base = posix.dirname(opfPath);
  const items = elementChildren(spine.el.children)
    .filter((i) => i.name === "itemref")
    .map((i) => hrefs.get(i.attrs.idref ?? ""))
    .map((href) => (href ? posix.normalize(posix.join(base, safeDecode(href.split("#")[0]!))) : ""));
  return { packageStep: (spine.index + 1) * 2, items };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The spine of an EPUB, cached by path and mtime. */
export async function readSpine(abs: string): Promise<Spine> {
  const info = await stat(abs);
  const key = `${abs}:${info.mtimeMs}:${info.size}`;
  const hit = spineCache.get(key);
  if (hit) return hit;
  const spine = await withZip(abs, readSpineFromZip);
  if (spineCache.size >= SPINE_CACHE_MAX) spineCache.delete(spineCache.keys().next().value!);
  spineCache.set(key, spine);
  return spine;
}

/** <html> and <body> of one spine item, plus body's CFI step. */
async function chapterBody(abs: string, spine: Spine, index: number): Promise<{ body: El; bodyStep: number } | null> {
  const path = spine.items[index];
  if (!path) return null;
  const doc = await withZip(abs, (zip) => zip.read(path, 8 * 1024 * 1024));
  const html = findChild(parseOrdered(doc.toString("utf8")), "html");
  if (!html) return null;
  const body = findChild(html.el.children, "body");
  return body ? { body: body.el, bodyStep: (body.index + 1) * 2 } : null;
}

// ---------------------------------------------------------------------------
// CFI
// ---------------------------------------------------------------------------

export interface ParsedCfi {
  /** 0-based spine index. */
  spineIndex: number;
  /** Element steps inside the chapter document, starting with body's (all even). */
  steps: number[];
}

/** Reads `epubcfi(/6/14[id]!/4/2/10/1:3)`; ranges use their common parent. */
export function parseCfi(cfi: string): ParsedCfi | null {
  const m = /^epubcfi\((.*)\)$/.exec(cfi.trim());
  if (!m) return null;
  const [pkgPart, docPart = ""] = m[1]!.split(",")[0]!.split("!");
  const stepsOf = (s: string): number[] => {
    const out: number[] = [];
    const re = /\/(\d+)(?:\[[^\]]*\])?/y;
    let pos = 0;
    while (pos < s.length) {
      re.lastIndex = pos;
      const mm = re.exec(s);
      if (!mm) break;
      out.push(Number(mm[1]));
      pos = re.lastIndex;
    }
    return out;
  };
  const pkgSteps = stepsOf(pkgPart ?? "");
  const itemref = pkgSteps[1];
  if (itemref === undefined || itemref < 2 || itemref % 2) return null;
  const steps: number[] = [];
  for (const s of stepsOf(docPart)) {
    if (s % 2) break; // a text node: stop at its element
    steps.push(s);
  }
  return { spineIndex: itemref / 2 - 1, steps };
}

export function chapterCfi(spine: Pick<Spine, "packageStep">, spineIndex: number, bodyStep = 4, steps: number[] = []): string {
  return `epubcfi(/${spine.packageStep}/${(spineIndex + 1) * 2}!/${[bodyStep, ...steps].join("/")})`;
}

// ---------------------------------------------------------------------------
// KOReader XPointer
// ---------------------------------------------------------------------------

/** `/body/DocFragment[12]/body/div/p[3]/text().0` → CFI for the same paragraph. */
export async function xpointerToCfi(abs: string, xpointer: string): Promise<string | null> {
  const m = /^\/body\/DocFragment\[(\d+)\](.*)$/.exec(xpointer.trim());
  if (!m) return null;
  const spineIndex = Number(m[1]) - 1;
  const spine = await readSpine(abs);
  if (spineIndex < 0 || spineIndex >= spine.items.length) return null;
  const chapter = await chapterBody(abs, spine, spineIndex).catch(() => null);
  if (!chapter) return chapterCfi(spine, spineIndex);

  const segs = m[2]!.split("/").filter(Boolean);
  const steps: number[] = [];
  if (segs[0]?.replace(/\..*$/, "") === "body") {
    let current = chapter.body;
    for (const seg of segs.slice(1)) {
      const sm = /^([A-Za-z][\w.-]*?)(?:\[(\d+)\])?(?:\.\d+)?$/.exec(seg);
      if (!sm || sm[1] === "text()" || seg.startsWith("text()")) break;
      const name = sm[1]!.toLowerCase();
      const nth = Number(sm[2] ?? 1);
      const kids = elementChildren(current.children);
      let seen = 0;
      const pos = kids.findIndex((k) => k.name === name && ++seen === nth);
      if (pos < 0) break;
      steps.push((pos + 1) * 2);
      current = kids[pos]!;
    }
  }
  return chapterCfi(spine, spineIndex, chapter.bodyStep, steps);
}

/** A CFI → the XPointer KOReader would use for that element. */
export async function cfiToXpointer(abs: string, cfi: string): Promise<string | null> {
  const parsed = parseCfi(cfi);
  if (!parsed) return null;
  const spine = await readSpine(abs);
  if (parsed.spineIndex >= spine.items.length) return null;
  const head = `/body/DocFragment[${parsed.spineIndex + 1}]/body`;
  const chapter = await chapterBody(abs, spine, parsed.spineIndex).catch(() => null);
  if (!chapter || parsed.steps[0] !== chapter.bodyStep) return head;

  const segs: string[] = [];
  let current = chapter.body;
  for (const step of parsed.steps.slice(1)) {
    const kids = elementChildren(current.children);
    const el = kids[step / 2 - 1];
    if (!el) break;
    const same = kids.filter((k) => k.name === el.name);
    segs.push(same.length > 1 ? `${el.name}[${same.indexOf(el) + 1}]` : el.name);
    current = el;
  }
  return segs.length ? `${head}/${segs.join("/")}` : head;
}

// ---------------------------------------------------------------------------
// Kobo
// ---------------------------------------------------------------------------

/** The spine item a Kobo bookmark's `Source` names (it may be relative to the OPF or the zip). */
export function spineIndexForSource(spine: Spine, source: string): number {
  const s = safeDecode(source.split("#")[0]!).replace(/^\/+/, "");
  if (!s) return -1;
  const exact = spine.items.indexOf(s);
  if (exact >= 0) return exact;
  return spine.items.findIndex((item) => item.endsWith(`/${s}`) || s.endsWith(`/${item}`));
}

export async function cfiForKoboSource(abs: string, source: string): Promise<string | null> {
  const spine = await readSpine(abs);
  const index = spineIndexForSource(spine, source);
  return index < 0 ? null : chapterCfi(spine, index);
}

export async function koboSourceForCfi(abs: string, cfi: string): Promise<string | null> {
  const parsed = parseCfi(cfi);
  if (!parsed) return null;
  const spine = await readSpine(abs);
  return spine.items[parsed.spineIndex] || null;
}
