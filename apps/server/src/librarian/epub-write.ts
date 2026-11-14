/**
 * "Write metadata into the file" for EPUB: rewrites the OPF's title, authors, language,
 * description, publisher, ISBN and Calibre series tags, then rebuilds the zip with `mimetype`
 * first and stored (as the EPUB spec wants). The new file is written next to the old one and
 * renamed over it, so a crash never leaves half a book. Never called for DRM files.
 */
import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import yauzl from "yauzl";
import yazl from "yazl";
import { asArray, attrOf, parseXml } from "../metadata/xml.js";

export interface EpubFields {
  title: string;
  authors: string[];
  language?: string | null;
  description?: string | null;
  publisher?: string | null;
  isbn13?: string | null;
  series?: { name: string; position: number | null } | null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Replace the fields we manage inside an OPF document's <metadata> block. Pure, for tests. */
export function rewriteOpf(opf: string, f: EpubFields): string {
  const open = opf.match(/<(?:opf:)?metadata\b[^>]*>/);
  const closeIdx = opf.search(/<\/(?:opf:)?metadata>/);
  if (!open || open.index === undefined || closeIdx < 0) throw new Error("OPF has no <metadata> block");
  const start = open.index + open[0].length;
  let md = opf.slice(start, closeIdx);

  const drop = (tag: string) => {
    md = md.replace(new RegExp(`<dc:${tag}\\b[^>]*/>`, "g"), "").replace(new RegExp(`<dc:${tag}\\b[^>]*>[\\s\\S]*?</dc:${tag}>`, "g"), "");
  };
  drop("title");
  // Authors only: keep illustrators, editors and other contributors.
  const removedIds: string[] = [];
  md = md.replace(/<dc:creator\b([^>]*)>[\s\S]*?<\/dc:creator>/g, (whole, attrs: string) => {
    const role = attrs.match(/role="([^"]*)"/)?.[1];
    if (role && role !== "aut") return whole;
    const id = attrs.match(/\bid="([^"]*)"/)?.[1];
    if (id) removedIds.push(id);
    return "";
  });
  // EPUB3 refinements (role, file-as) of the creators we removed would dangle.
  for (const id of removedIds) {
    const ref = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    md = md.replace(new RegExp(`<meta\\b[^>]*refines="#${ref}"[^>]*(?:/>|>[\\s\\S]*?</meta>)`, "g"), "");
  }
  if (f.language) drop("language");
  if (f.description != null) drop("description");
  if (f.publisher != null) drop("publisher");
  md = md.replace(/<meta\b[^>]*name="calibre:series(?:_index)?"[^>]*\/>/g, "");
  // Identifiers stay (one is the package's unique-identifier); the ISBN is added when missing.
  const hasIsbn = !!f.isbn13 && md.replace(/[-\s]/g, "").includes(f.isbn13);

  const role = /xmlns:opf=/.test(opf) ? ' opf:role="aut"' : "";
  const add: string[] = [`<dc:title>${esc(f.title)}</dc:title>`];
  for (const a of f.authors) add.push(`<dc:creator${role}>${esc(a)}</dc:creator>`);
  if (f.language) add.push(`<dc:language>${esc(f.language)}</dc:language>`);
  if (f.description) add.push(`<dc:description>${esc(f.description)}</dc:description>`);
  if (f.publisher) add.push(`<dc:publisher>${esc(f.publisher)}</dc:publisher>`);
  if (f.isbn13 && !hasIsbn) add.push(`<dc:identifier>urn:isbn:${esc(f.isbn13)}</dc:identifier>`);
  if (f.series) {
    add.push(`<meta name="calibre:series" content="${esc(f.series.name)}"/>`);
    if (f.series.position != null) add.push(`<meta name="calibre:series_index" content="${f.series.position}"/>`);
  }
  md = md.replace(/\n\s*\n+/g, "\n");
  const body = `${md.replace(/\s+$/, "")}\n    ${add.join("\n    ")}\n  `;

  return opf.slice(0, start) + body + opf.slice(closeIdx);
}

interface Entry {
  name: string;
  data: Buffer;
  mtime: Date;
}

function readAll(path: string): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("Could not open zip"));
      const out: Entry[] = [];
      zip.on("entry", (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error("No stream"));
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.once("error", reject);
          stream.once("end", () => {
            out.push({ name: entry.fileName, data: Buffer.concat(chunks), mtime: entry.getLastModDate() });
            zip.readEntry();
          });
        });
      });
      zip.once("error", reject);
      zip.once("end", () => resolve(out));
      zip.readEntry();
    });
  });
}

function opfPathOf(entries: Entry[]): string {
  const container = entries.find((e) => e.name === "META-INF/container.xml");
  if (container) {
    const xml = parseXml(container.data.toString("utf8")) as Record<string, any>;
    const rootfile = asArray(asArray(xml.container?.rootfiles)[0]?.rootfile)[0];
    const p = attrOf(rootfile, "full-path");
    if (p && entries.some((e) => e.name === p)) return p;
  }
  const guess = entries.find((e) => e.name.toLowerCase().endsWith(".opf"));
  if (!guess) throw new Error("EPUB has no OPF package document");
  return guess.name;
}

/** Rewrites the EPUB at `absPath` in place. */
export async function writeEpubMetadata(absPath: string, fields: EpubFields): Promise<void> {
  const entries = await readAll(absPath);
  const opfPath = opfPathOf(entries);
  const opf = entries.find((e) => e.name === opfPath)!;
  opf.data = Buffer.from(rewriteOpf(opf.data.toString("utf8"), fields), "utf8");

  const zip = new yazl.ZipFile();
  const mimetype = entries.find((e) => e.name === "mimetype");
  zip.addBuffer(mimetype?.data ?? Buffer.from("application/epub+zip"), "mimetype", { compress: false, mtime: mimetype?.mtime });
  for (const e of entries) if (e.name !== "mimetype") zip.addBuffer(e.data, e.name, { compress: true, mtime: e.mtime });
  zip.end();

  // Hidden temp name in the same folder: scans skip it, and rename is atomic on one filesystem.
  const tmp = join(dirname(absPath), `.${basename(absPath)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tmp);
      zip.outputStream.pipe(out);
      out.once("finish", resolve);
      out.once("error", reject);
      zip.outputStream.once("error", reject);
    });
    if (!(await stat(tmp)).size) throw new Error("Rewritten EPUB is empty");
    await rename(tmp, absPath);
  } finally {
    await rm(tmp, { force: true });
  }
}
