/** EPUBs and a fake Kokoro server for the read-aloud tests. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import yazl from "yazl";

export function makeStoryEpub(path: string, chapters: string[], opts: { mediaOverlay?: boolean } = {}): Promise<void> {
  const mo = opts.mediaOverlay;
  const manifest =
    chapters.map((_, i) => `<item id="c${i}" href="text/c${i}.xhtml" media-type="application/xhtml+xml"${mo ? ` media-overlay="s${i}"` : ""}/>`).join("") +
    (mo ? chapters.map((_, i) => `<item id="s${i}" href="smil/c${i}.smil" media-type="application/smil+xml"/>`).join("") : "");
  const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("");
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
  const entries: [string, string][] = [
    ["mimetype", "application/epub+zip"],
    [
      "META-INF/container.xml",
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
    ],
    ["OEBPS/content.opf", opf],
    ...chapters.map((c, i): [string, string] => [`OEBPS/text/c${i}.xhtml`, `<html><head><title>x</title></head><body>${c.split("\n\n").map((p) => `<p>${p}</p>`).join("")}</body></html>`]),
  ];
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, data] of entries) zip.addBuffer(Buffer.from(data), name);
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.concat(chunks));
      resolve();
    });
  });
}

export const CHAPTER_ONE = [
  "Pip the mouse lived under the old oak tree at the edge of the meadow. Every morning Pip woke up early and went looking for breakfast.",
  "One day Pip found a shiny red berry beside the pond. Pip carried the berry home and shared it with Hazel the hedgehog.",
  "Hazel was very grateful. She gave Pip a warm blanket made of thistledown, because the nights were getting colder.",
  "That evening the wind began to howl around the oak tree. Pip snuggled under the blanket and listened to the rain tapping on the leaves.",
  "In the morning the meadow sparkled with puddles. Pip and Hazel splashed through every single one until their feet were soaking wet.",
].join("\n\n");

export interface KokoroCall {
  url: string;
  body: Record<string, unknown> | undefined;
}

/** A fake Kokoro-FastAPI: /dev/captioned_speech (unless `captions` is false), /v1/audio/speech, /v1/audio/voices. */
export function fakeKokoro(opts: { captions?: boolean } = {}) {
  const calls: KokoroCall[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/dev/captioned_speech")) {
      if (opts.captions === false) return new Response("Not Found", { status: 404 });
      const words = String(body?.input ?? "").split(/\s+/).filter(Boolean);
      return Response.json({
        audio: Buffer.from(`MP3:${body?.voice}:${body?.input}`).toString("base64"),
        audio_format: "mp3",
        timestamps: words.map((w, i) => ({ word: w, start_time: i * 0.4, end_time: i * 0.4 + 0.35 })),
      });
    }
    if (url.endsWith("/v1/audio/speech")) return new Response(Buffer.from(`MP3:${body?.voice}:${body?.input}`), { headers: { "content-type": "audio/mpeg" } });
    if (url.endsWith("/v1/audio/voices")) return Response.json({ voices: ["af_heart", "af_bella", "bm_george"] });
    return new Response("nf", { status: 404 });
  };
  return { fetchImpl, calls, speechCalls: () => calls.filter((c) => /speech$/.test(c.url)) };
}
