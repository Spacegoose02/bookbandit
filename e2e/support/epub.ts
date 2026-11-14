/** Writes small but real EPUB 3 files for the test library. */
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import yazl from "yazl";

export interface EpubSpec {
  title: string;
  author: string;
  /** Chapters to write; each gets a few pages of text so the reader has somewhere to go. */
  chapters?: number;
  id: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function writeEpub(path: string, spec: EpubSpec): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const n = spec.chapters ?? 4;
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from("application/epub+zip"), "mimetype", { compress: false });
  zip.addBuffer(
    Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    "META-INF/container.xml",
  );
  const chapters = Array.from({ length: n }, (_, i) => i + 1);
  zip.addBuffer(
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${spec.id}</dc:identifier>
    <dc:title>${esc(spec.title)}</dc:title>
    <dc:creator>${esc(spec.author)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${chapters.map((c) => `    <item id="c${c}" href="c${c}.xhtml" media-type="application/xhtml+xml"/>`).join("\n")}
  </manifest>
  <spine>
${chapters.map((c) => `    <itemref idref="c${c}"/>`).join("\n")}
  </spine>
</package>`),
    "OEBPS/content.opf",
  );
  zip.addBuffer(
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${esc(spec.title)}</title></head>
<body><nav epub:type="toc"><ol>
${chapters.map((c) => `<li><a href="c${c}.xhtml">Chapter ${c}</a></li>`).join("\n")}
</ol></nav></body></html>`),
    "OEBPS/nav.xhtml",
  );
  for (const c of chapters) {
    const paras = Array.from(
      { length: 18 },
      (_, p) =>
        `<p>${esc(spec.title)}, chapter ${c}, paragraph ${p + 1}. The raccoon tiptoed past the shelves, counting spines and humming, ` +
        `while the lamp made long shadows and the pages turned themselves one by one in the warm evening air.</p>`,
    ).join("\n");
    zip.addBuffer(
      Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${c}</title></head>
<body><h1>Chapter ${c}</h1>
${paras}
</body></html>`),
      `OEBPS/c${c}.xhtml`,
    );
  }
  zip.end();
  return new Promise((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(path)).on("close", () => resolve()).on("error", reject);
  });
}
