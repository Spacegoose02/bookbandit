/**
 * A stand-in for an OpenAI-compatible model server (what Ollama, LM Studio and llama.cpp speak).
 * It records every request so tests can check what the server sent the model, and answers by
 * repeating every library title it was shown, so a leak in the context shows up in the reply too.
 */
import { createServer, type Server } from "node:http";

export interface RecordedCall {
  at: number;
  body: { model?: string; messages?: { role: string; content: string }[] };
}

export function startFakeAi(): Promise<{ server: Server; port: number }> {
  const calls: RecordedCall[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/__calls") return send(200, calls);
      if (req.method === "DELETE" && req.url === "/__calls") {
        calls.length = 0;
        return send(200, { ok: true });
      }
      if (req.method === "GET" && req.url?.endsWith("/models")) return send(200, { data: [{ id: "fake-model" }] });
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        const body = JSON.parse(raw || "{}") as RecordedCall["body"];
        calls.push({ at: Date.now(), body });
        const all = (body.messages ?? []).map((m) => m.content).join("\n");
        if (/content safety checker/i.test(all)) return send(200, reply('{"flagged": false}'));
        // Echo every quoted or listed title the prompt contained.
        const titles = [...new Set([...all.matchAll(/"([^"\n]{3,80})"/g)].map((m) => m[1]))];
        return send(200, reply(`Barnaby here! From the shelves I was shown: ${titles.map((t) => `"${t}"`).join(", ") || "nothing"}.`));
      }
      send(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

function reply(content: string) {
  return {
    id: "fake",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}
