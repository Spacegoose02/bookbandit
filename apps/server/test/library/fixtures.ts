/** Builds small but real EPUB / CBZ / PDF files for tests. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yazl from "yazl";
import { PDFDocument } from "pdf-lib";

// 1x1 PNG
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export async function tempDir(prefix = "bookbandit-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function zipTo(path: string, entries: { name: string; data: Buffer | string; store?: boolean }[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const e of entries) {
      zip.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), e.name, { compress: !e.store });
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.concat(chunks));
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface EpubOpts {
  title?: string;
  authors?: string[];
  isbn?: string;
  subjects?: string[];
  series?: string;
  seriesIndex?: number;
  description?: string;
  cover?: boolean;
  /** Makes otherwise identical books hash differently. */
  salt?: string;
}

export async function makeEpub(path: string, o: EpubOpts = {}): Promise<void> {
  const creators = (o.authors ?? []).map((a) => `<dc:creator opf:role="aut">${a}</dc:creator>`).join("\n");
  const subjects = (o.subjects ?? []).map((s) => `<dc:subject>${s}</dc:subject>`).join("\n");
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    ${o.title ? `<dc:title>${o.title}</dc:title>` : ""}
    ${creators}
    <dc:identifier id="id">urn:uuid:0c7a0f8e-1b1e-4c55-9d4f-${(o.salt ?? "000000000000").padEnd(12, "0").slice(0, 12)}</dc:identifier>
    ${o.isbn ? `<dc:identifier opf:scheme="ISBN">${o.isbn}</dc:identifier>` : ""}
    <dc:language>en</dc:language>
    <dc:date>2019-05-01</dc:date>
    ${o.description ? `<dc:description>${esc(`<p>${o.description}</p>`)}</dc:description>` : ""}
    ${subjects}
    ${o.series ? `<meta name="calibre:series" content="${o.series}"/><meta name="calibre:series_index" content="${o.seriesIndex ?? 1}"/>` : ""}
    ${o.cover ? `<meta name="cover" content="cover-img"/>` : ""}
  </metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    ${o.cover ? `<item id="cover-img" href="images/cover.png" media-type="image/png"/>` : ""}
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
  const entries: { name: string; data: Buffer | string; store?: boolean }[] = [
    { name: "mimetype", data: "application/epub+zip", store: true },
    {
      name: "META-INF/container.xml",
      data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    { name: "OEBPS/content.opf", data: opf },
    { name: "OEBPS/c1.xhtml", data: `<html><body><p>Once upon a time ${o.salt ?? ""}</p></body></html>` },
  ];
  if (o.cover) entries.push({ name: "OEBPS/images/cover.png", data: PNG });
  await zipTo(path, entries);
}

export async function makeCbz(path: string, info?: Record<string, string>, pages = 3): Promise<void> {
  const entries: { name: string; data: Buffer | string }[] = [];
  for (let i = pages; i >= 1; i--) entries.push({ name: `page${String(i).padStart(3, "0")}.png`, data: PNG });
  if (info) {
    const body = Object.entries(info).map(([k, v]) => `<${k}>${v}</${k}>`).join("");
    entries.push({ name: "ComicInfo.xml", data: `<?xml version="1.0"?><ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema">${body}</ComicInfo>` });
  }
  await zipTo(path, entries);
}

export async function makePdf(path: string, o: { title?: string; author?: string; keywords?: string[]; pages?: number } = {}): Promise<void> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < (o.pages ?? 2); i++) doc.addPage([200, 200]);
  if (o.title) doc.setTitle(o.title);
  if (o.author) doc.setAuthor(o.author);
  if (o.keywords) doc.setKeywords(o.keywords);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await doc.save());
}

/** A fake fetch that answers from a list of [urlSubstring, body] routes; records calls. */
export function fakeFetch(routes: [string | RegExp, unknown, { status?: number; contentType?: string }?][]) {
  const calls: string[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    const key = init?.body ? `${url} ${String(init.body)}` : url;
    calls.push(key);
    for (const [match, body, opts] of routes) {
      if (typeof match === "string" ? key.includes(match) : match.test(key)) {
        const isBuf = Buffer.isBuffer(body);
        return new Response(isBuf ? new Uint8Array(body as Buffer) : JSON.stringify(body), {
          status: opts?.status ?? 200,
          headers: { "content-type": opts?.contentType ?? (isBuf ? "image/jpeg" : "application/json") },
        });
      }
    }
    return new Response("{}", { status: 404 });
  };
  return { fetch: fn, calls };
}
