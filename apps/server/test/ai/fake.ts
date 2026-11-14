/** A fake Ollama (OpenAI-compatible), SearXNG and friends for Barnaby tests. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import yazl from "yazl";

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

export type Responder = (call: Call) => unknown | Promise<unknown>;

export function fakeAi() {
  const calls: Call[] = [];
  let chatReply: Responder = () => "Hello from Barnaby!";
  let moderationReply: Responder = () => '{"flagged": false}';
  let searchResults: { url: string; title: string; content: string }[] = [];
  let embedFails = false;

  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { url, method: init.method ?? "GET", headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("http://searx")) return json({ results: searchResults });
    if (url.endsWith("/models")) return json({ data: [{ id: "llama3.2" }, { id: "llama-guard3" }] });
    if (url.endsWith("/embeddings")) {
      if (embedFails) return json({ error: "embedding model not found" }, 404);
      const input = call.body.input as string[];
      return json({ model: call.body.model, data: input.map((t, index) => ({ index, embedding: fakeEmbedding(t) })), usage: { prompt_tokens: input.length } });
    }
    if (url.endsWith("/chat/completions")) {
      const isMod = call.body.model === "llama-guard3";
      const text = String(await (isMod ? moderationReply : chatReply)(call));
      if (call.body.stream) {
        // Three pieces, like a real model writing as it goes.
        const n = Math.ceil(text.length / 3) || 1;
        const pieces = [0, 1, 2].map((i) => text.slice(i * n, (i + 1) * n)).filter(Boolean);
        const sse =
          pieces.map((p) => `data: ${JSON.stringify({ model: call.body.model, choices: [{ delta: { content: p } }] })}\n\n`).join("") + "data: [DONE]\n\n";
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return json({ model: call.body.model, choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }
    return json({ error: "not found" }, 404);
  };

  return {
    fetchImpl,
    calls,
    chatCalls: () => calls.filter((c) => c.url.endsWith("/chat/completions") && c.body.model !== "llama-guard3"),
    modCalls: () => calls.filter((c) => c.url.endsWith("/chat/completions") && c.body.model === "llama-guard3"),
    searchCalls: () => calls.filter((c) => c.url.startsWith("http://searx")),
    /** The system prompt of the last chat call. */
    lastSystem: () => {
      const c = calls.filter((x) => x.url.endsWith("/chat/completions") && x.body.model !== "llama-guard3").at(-1);
      return c?.body.messages[0].content as string;
    },
    setChat: (r: Responder) => void (chatReply = r),
    setModeration: (r: Responder) => void (moderationReply = r),
    setSearch: (r: typeof searchResults) => void (searchResults = r),
    embedCalls: () => calls.filter((c) => c.url.endsWith("/embeddings")),
    failEmbeddings: (v = true) => void (embedFails = v),
  };
}

/**
 * A toy embedding: words (minus a few stop words and the nomic prefixes) hashed into 512 buckets.
 * Texts that share words point the same way, which is all the tests need.
 */
const STOP = new Set(["the", "and", "for", "with", "her", "his", "a", "an", "of", "to", "in", "on", "by", "about", "book", "books", "search", "query", "document", "genres", "series"]);
export function fakeEmbedding(text: string): number[] {
  const v = new Array(512).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 512] += 1;
  }
  v[511] += 0.01; // never all zeros
  return v;
}

export const OLLAMA_SETTINGS = {
  providers: [
    { id: "ollama", name: "Ollama", kind: "openai", baseUrl: "http://ollama:11434/v1", model: "llama3.2" },
    { id: "guard", name: "Llama Guard", kind: "openai", baseUrl: "http://ollama:11434/v1", model: "llama-guard3" },
  ],
  features: { chat: "ollama", moderation: "guard", rating: "ollama" },
  search: { enabled: true, url: "http://searx:8080" },
};

/** A tiny EPUB with one chapter per entry of `chapters`. */
export function makeChapteredEpub(path: string, chapters: string[]): Promise<void> {
  const manifest = chapters.map((_, i) => `<item id="c${i}" href="text/c${i}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  const spine = chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("");
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;
  const entries: [string, string][] = [
    ["mimetype", "application/epub+zip"],
    [
      "META-INF/container.xml",
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
    ],
    ["OEBPS/content.opf", opf],
    ...chapters.map((c, i): [string, string] => [`OEBPS/text/c${i}.xhtml`, `<html><head><title>x</title><style>p{}</style></head><body><p>${c}</p></body></html>`]),
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

/** OLLAMA_SETTINGS plus an embeddings model, for meaning search. */
export const EMBED_SETTINGS = {
  ...OLLAMA_SETTINGS,
  providers: [...OLLAMA_SETTINGS.providers, { id: "embed", name: "Ollama embeddings", kind: "openai", baseUrl: "http://ollama:11434/v1", model: "nomic-embed-text" }],
  features: { ...OLLAMA_SETTINGS.features, embeddings: "embed" },
};
