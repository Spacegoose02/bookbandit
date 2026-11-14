/** EPUB metadata: reads the OPF package document (Dublin Core + Calibre/EPUB3 series) and the cover. */
import { posix } from "node:path";
import type { FileMetadata } from "./types.js";
import { openZip, type ZipReader } from "./zip.js";
import { asArray, attrOf, parseXml, textOf } from "./xml.js";
import { toIsbn13 } from "./isbn.js";
import { authorDisplayName, collapse, stripHtml, yearFrom } from "./text.js";

type Node = Record<string, unknown>;

export async function readEpub(path: string): Promise<FileMetadata> {
  const zip = await openZip(path);
  try {
    return await readFromZip(zip);
  } finally {
    zip.close();
  }
}

async function readFromZip(zip: ZipReader): Promise<FileMetadata> {
  const container = parseXml((await zip.read("META-INF/container.xml")).toString("utf8"));
  const rootfiles = asArray((container.container as Node | undefined)?.rootfiles as Node | Node[] | undefined) as Node[];
  const rootfile = asArray(rootfiles[0]?.rootfile as Node | Node[] | undefined)[0];
  const opfPath = attrOf(rootfile, "full-path") ?? zip.names.find((n) => n.toLowerCase().endsWith(".opf"));
  if (!opfPath) throw new Error("EPUB has no OPF package document");

  const opf = parseXml((await zip.read(opfPath)).toString("utf8"));
  const pkg = (opf.package ?? {}) as Node;
  const md = (pkg.metadata ?? {}) as Node;
  const metas = asArray(md.meta as Node | Node[] | undefined);
  const out: FileMetadata = {};

  out.title = collapse(textOf(asArray(md.title)[0]) ?? "") || undefined;

  const creators = asArray(md.creator as unknown[] | undefined);
  const authorIds = new Set(
    metas
      .filter((m) => attrOf(m, "property") === "role" && textOf(m) !== "aut")
      .map((m) => attrOf(m, "refines")?.replace(/^#/, "")),
  );
  const authors = creators
    .filter((c) => {
      const role = attrOf(c, "role");
      if (role && role !== "aut") return false;
      const id = attrOf(c, "id");
      return !(id && authorIds.has(id));
    })
    .map((c) => textOf(c))
    .filter((s): s is string => !!s)
    .map(authorDisplayName);
  if (authors.length) out.authors = [...new Set(authors)];

  const desc = textOf(asArray(md.description)[0]);
  if (desc) out.description = stripHtml(desc);
  out.language = textOf(asArray(md.language)[0])?.toLowerCase();
  out.publisher = textOf(asArray(md.publisher)[0]);
  out.publishedYear = yearFrom(textOf(asArray(md.date)[0]));

  for (const ident of asArray(md.identifier as unknown[] | undefined)) {
    const scheme = attrOf(ident, "scheme")?.toLowerCase();
    const value = textOf(ident) ?? "";
    const looksLikeIsbn = scheme === "isbn" || /isbn/i.test(value) || /^[\d\s-]{9,}[\dXx]$/.test(value.trim());
    const isbn = looksLikeIsbn ? toIsbn13(value) : undefined;
    if (isbn) {
      out.isbn13 = isbn;
      break;
    }
  }

  const subjects = asArray(md.subject as unknown[] | undefined)
    .map((s) => textOf(s))
    .filter((s): s is string => !!s);
  if (subjects.length) out.subjects = subjects;

  // Series: Calibre's <meta name="calibre:series"> or EPUB3 belongs-to-collection.
  const metaNamed = (name: string) => attrOf(metas.find((m) => attrOf(m, "name") === name), "content");
  const calibreSeries = metaNamed("calibre:series");
  if (calibreSeries) {
    out.series = collapse(calibreSeries);
    const idx = Number(metaNamed("calibre:series_index"));
    if (Number.isFinite(idx)) out.seriesPosition = idx;
  } else {
    const coll = metas.find((m) => attrOf(m, "property") === "belongs-to-collection");
    const name = textOf(coll);
    if (coll && name) {
      out.series = collapse(name);
      const id = attrOf(coll, "id");
      const pos = metas.find(
        (m) => attrOf(m, "property") === "group-position" && attrOf(m, "refines") === `#${id}`,
      );
      const n = Number(textOf(pos));
      if (Number.isFinite(n)) out.seriesPosition = n;
    }
  }

  // Cover: EPUB3 properties="cover-image", else EPUB2 <meta name="cover" content="id">.
  const items = asArray(((pkg.manifest ?? {}) as Node).item as Node | Node[] | undefined);
  const coverId = metaNamed("cover");
  const coverItem =
    items.find((i) => (attrOf(i, "properties") ?? "").split(/\s+/).includes("cover-image")) ??
    items.find((i) => coverId && attrOf(i, "id") === coverId && /^image\//.test(attrOf(i, "media-type") ?? "")) ??
    items.find((i) => /cover/i.test(attrOf(i, "id") ?? "") && /^image\//.test(attrOf(i, "media-type") ?? ""));
  const href = attrOf(coverItem, "href");
  if (href) {
    const coverPath = posix.normalize(posix.join(posix.dirname(opfPath), decodeURIComponent(href)));
    try {
      out.cover = { data: await zip.read(coverPath, 10 * 1024 * 1024), mime: attrOf(coverItem, "media-type")! };
    } catch {
      // A broken cover reference shouldn't fail the whole import.
    }
  }

  return out;
}
