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

export interface AiProvider {
  readonly config: ProviderConfig;
  chat(req: ChatRequest): Promise<ChatResult>;
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

export const trimSlash = (u: string) => u.replace(/\/+$/, "");
