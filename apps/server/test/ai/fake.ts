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

  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { url, method: init.method ?? "GET", headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("http://searx")) return json({ results: searchResults });
    if (url.endsWith("/models")) return json({ data: [{ id: "llama3.2" }, { id: "llama-guard3" }] });
    if (url.endsWith("/chat/completions")) {
      const isMod = call.body.model === "llama-guard3";
      const text = await (isMod ? moderationReply : chatReply)(call);
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
  };
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
