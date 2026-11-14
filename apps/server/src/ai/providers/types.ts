/** One shape for every chat model Barnaby can talk to. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const PROVIDER_KINDS = ["openai", "anthropic", "gemini"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object back (used by moderation and the rating helper). */
  json?: boolean;
}

export interface ChatResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  /** OpenAI-compatible servers: required (e.g. http://ollama:11434/v1). Others: optional override. */
  baseUrl?: string;
  model: string;
  apiKey?: string;
  /** Per-call timeout; local models on a CPU can be slow. */
  timeoutMs?: number;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  inputTokens?: number;
}

export interface AiProvider {
  readonly config: ProviderConfig;
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Same as chat, but calls `onDelta` with each piece of text as it arrives. */
  chatStream(req: ChatRequest, onDelta: (text: string) => void): Promise<ChatResult>;
  /** Text embeddings for meaning search. Throws a ProviderError when the provider has none. */
  embed(texts: string[]): Promise<EmbedResult>;
  listModels(): Promise<string[]>;
}

export class ProviderError extends Error {
  statusCode = 502;
  constructor(
    message: string,
    public upstreamStatus?: number,
  ) {
    super(message);
  }
}

/** fetch + JSON with a timeout and a readable error that never echoes the API key. */
export async function postJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: unknown; timeoutMs: number; label: string },
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", accept: "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
  } catch (e) {
    const msg = ctrl.signal.aborted ? `timed out after ${Math.round(init.timeoutMs / 1000)} s` : (e as Error).message;
    throw new ProviderError(`${init.label}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
      detail = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message ?? "");
    } catch {
      /* not JSON */
    }
    throw new ProviderError(`${init.label}: HTTP ${res.status}${detail ? ` (${detail.slice(0, 200)})` : ""}`, res.status);
  }
  return (await res.json()) as T;
}

/**
 * POST and read a server-sent-events reply, calling `onData` with each `data:` payload
 * (parsed as JSON; `[DONE]` and non-JSON lines are skipped). The timeout covers the whole stream.
 */
export async function postSse(
  fetchImpl: FetchLike,
  url: string,
  init: { headers: Record<string, string>; body: unknown; timeoutMs: number; label: string },
  onData: (data: any) => void,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...init.headers },
        body: JSON.stringify(init.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ProviderError(`${init.label}: ${ctrl.signal.aborted ? `timed out after ${Math.round(init.timeoutMs / 1000)} s` : (e as Error).message}`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
        detail = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message ?? "");
      } catch {
        /* not JSON */
      }
      throw new ProviderError(`${init.label}: HTTP ${res.status}${detail ? ` (${detail.slice(0, 200)})` : ""}`, res.status);
    }
    // Some OpenAI-compatible servers ignore `stream: true` and answer with plain JSON.
    if (!(res.headers.get("content-type") ?? "").includes("event-stream")) {
      onData(await res.json());
      return;
    }
    const decoder = new TextDecoder();
    let buf = "";
    const handle = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      try {
        onData(JSON.parse(data));
      } catch {
        /* keep-alive or junk */
      }
    };
    const reader = res.body?.getReader();
    if (!reader) return;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          handle(buf.slice(0, nl).replace(/\r$/, ""));
          buf = buf.slice(nl + 1);
        }
      }
    } catch (e) {
      throw new ProviderError(`${init.label}: ${ctrl.signal.aborted ? `timed out after ${Math.round(init.timeoutMs / 1000)} s` : (e as Error).message}`);
    }
    handle(buf.trim());
  } finally {
    clearTimeout(timer);
  }
}

export const trimSlash = (u: string) => u.replace(/\/+$/, "");
