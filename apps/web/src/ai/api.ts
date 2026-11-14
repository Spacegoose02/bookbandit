/**
 * Barnaby's API client. Endpoints are documented in docs/ai.md; the demo version below
 * answers from the sample library so the chat can be shown without a server or model.
 */
import { api as libraryApi, ApiError, isDemo } from "../api/client";
import type { BookSummary } from "../api/types";

export interface AiStatus {
  available: boolean;
  reason: "not_configured" | "off" | "too_young" | "no_birth_year" | "daily_limit" | null;
  message: string | null;
  kid: boolean;
  webSearch: boolean;
  bookChat: boolean;
  remainingToday: number | null;
  /** Meaning search is set up and this reader may use it. */
  meaningSearch?: boolean;
  /** "Find a book" (smart requests): grown-ups with a chat provider. */
  smartRequests?: boolean;
}

/** A book Barnaby found: "more like this" adds `reason`, meaning search adds `score`. */
export interface FoundBook extends BookSummary {
  reason?: string;
  score?: number;
}

export interface SmartRequestResult {
  interpreted: {
    like: string[];
    age: number | null;
    topics: string[];
    maxRating: string;
    forKid: { id: string; displayName: string } | null;
  };
  picks: (BookSummary & { reason: string })[];
  outside: { title: string; author: string; reason: string }[];
}

export type MetadataField = "title" | "subtitle" | "authors" | "series" | "description";
export type MetadataValue = string | string[] | { name: string; position: number | null } | null;

export interface MetadataSuggestion {
  id: string;
  bookId: string;
  bookTitle: string;
  field: MetadataField;
  current: MetadataValue;
  suggested: MetadataValue;
  reason: string;
  status: "pending" | "accepted" | "dismissed";
}

export interface EmbeddingStatus {
  configured: boolean;
  model: string | null;
  indexed: number;
  total: number;
  job: { id: string; status: string; progress: number | null; lastError: string | null; finishedAt: number | null } | null;
}

export interface AiSource {
  kind: "web" | "book";
  title: string;
  url?: string | null;
  bookId?: string | null;
}

export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  moderation: string | null;
  createdAt: number;
  sources: AiSource[];
}

export interface AiConversation {
  id: string;
  title: string;
  bookId: string | null;
  kid: boolean;
  flagged: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ChatResponse {
  conversationId: string;
  message: AiMessage;
  reply: AiMessage;
  remainingToday: number | null;
  searchError: string | null;
}

export interface KidAiSettings {
  enabled: boolean;
  webSearch: boolean;
  dailyLimit: number;
  updatedAt: number | null;
}

export interface KidAiRow {
  id: string;
  displayName: string;
  avatar: string | null;
  age: number | null;
  settings: KidAiSettings;
  status: "on" | AiStatus["reason"];
  sentToday: number;
  flaggedConversations: number;
}

export type ProviderKind = "openai" | "anthropic" | "gemini";

export interface ProviderSettings {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  /** $ per million tokens, for cost estimates. Unset: built-in table, local servers free. */
  price?: { input: number; output: number };
  hasApiKey?: boolean;
  /** Only sent when changing it; "" removes it. */
  apiKey?: string | null;
}

export const AI_FEATURES = ["chat", "kidChat", "bookChat", "moderation", "rating", "metadata", "embeddings"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export interface AiSettings {
  providers: ProviderSettings[];
  features: Record<AiFeature, string | null>;
  search: { enabled: boolean; url?: string; safeSearch: 0 | 1 | 2; kidAllowlist: string[]; maxResults: number };
  moderation: { adults: boolean };
  kidDefaults: { dailyLimit: number };
  /** What happens once the rating helper has looked at a book. */
  ratingHelper?: { autoApprove: boolean; trustLooser: boolean; minConfidence: number };
}

export interface RatingRunStatus {
  jobId?: string | null;
  running: boolean;
  total: number;
  done: number;
  suggested: number;
  applied: number;
  failed: number;
  lastError: string | null;
  /** Where the whole library stands (not just the last run). */
  progress?: BatchProgress;
  estimate?: CostEstimate;
  spent?: Spend;
}

export interface BatchProgress {
  /** Books the tool is about: unrated books for the rating helper, every book for metadata cleanup. */
  total: number;
  /** Books still to look at; 0 with nothing failed means done. */
  remaining: number;
  /** Suggestions waiting for an admin (metadata: books with fixes; `fixes` counts the fields). */
  waiting: number;
  fixes?: number;
  /** Books that failed and are skipped until tried again. */
  failed: number;
  /** Of `waiting`, the books still in the Inbox (reviewed there). */
  inInbox?: number;
}

export interface CostEstimate {
  provider: string | null;
  model: string | null;
  source: "local" | "custom" | "table" | "unknown";
  free: boolean;
  perBook: number | null;
  basis: "history" | "guess";
}

export interface Spend {
  dollars: number;
  calls: number;
  partial: boolean;
}

/** How many books a batch run takes: the next `limit`, everything left, or the ones that failed. */
export type BatchRun = { limit?: number; all?: boolean; retryFailed?: boolean };

export interface RatingSuggestion {
  bookId: string;
  title: string;
  rating: string;
  confidence: number;
  reasons: string;
  currentRating: string | null;
  status: string;
}

export type ChatBody = { message: string; conversationId?: string; bookId?: string; webSearch?: boolean };

export interface AiApi {
  status(): Promise<AiStatus>;
  chat(body: ChatBody): Promise<ChatResponse>;
  /** Like chat, calling `onDelta` with each piece of the reply as Barnaby writes it. */
  chatStream(body: ChatBody, onDelta: (text: string) => void): Promise<ChatResponse>;
  similar(bookId: string, limit?: number): Promise<FoundBook[]>;
  meaningSearch(q: string, limit?: number): Promise<{ available: boolean; items: FoundBook[]; error?: string }>;
  smartRequest(text: string, forKidId?: string): Promise<SmartRequestResult>;
  embeddings(): Promise<EmbeddingStatus>;
  startEmbeddings(): Promise<EmbeddingStatus>;
  metadataStatus(): Promise<RatingRunStatus>;
  startMetadata(run: BatchRun): Promise<RatingRunStatus>;
  metadataSuggestions(): Promise<MetadataSuggestion[]>;
  acceptMetadata(id: string, value?: MetadataValue): Promise<void>;
  dismissMetadata(id: string): Promise<void>;
  conversations(bookId?: string): Promise<AiConversation[]>;
  conversation(id: string): Promise<{ conversation: AiConversation; messages: AiMessage[] }>;
  deleteConversation(id: string): Promise<void>;
  kids(): Promise<KidAiRow[]>;
  setKidSettings(kidId: string, s: Omit<KidAiSettings, "updatedAt">): Promise<KidAiSettings>;
  kidConversations(kidId: string): Promise<AiConversation[]>;
  kidConversation(kidId: string, id: string): Promise<{ conversation: AiConversation; messages: AiMessage[] }>;
  settings(): Promise<AiSettings>;
  saveSettings(s: AiSettings): Promise<AiSettings>;
  testProvider(providerId: string): Promise<{ ok: boolean; reply?: string; model?: string; error?: string; ms: number }>;
  models(providerId: string): Promise<string[]>;
  testSearch(q: string, kid: boolean): Promise<{ ok: boolean; error?: string; items: { title: string; url: string }[] }>;
  ratingStatus(): Promise<RatingRunStatus>;
  startRating(run: BatchRun): Promise<RatingRunStatus>;
  /** Stop a running batch (the job runner's cancel). */
  cancelJob(jobId: string): Promise<void>;
  suggestions(): Promise<RatingSuggestion[]>;
  acceptSuggestion(bookId: string, rating?: string): Promise<void>;
  dismissSuggestion(bookId: string): Promise<void>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const enc = encodeURIComponent;

/** POST /api/ai/chat/stream and read its server-sent events. */
async function chatStream(body: ChatBody, onDelta: (text: string) => void): Promise<ChatResponse> {
  const res = await fetch("/api/ai/chat/stream", {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { message?: string };
      if (b.message) message = b.message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (!(res.headers.get("content-type") ?? "").includes("event-stream") || !res.body) return (await res.json()) as ChatResponse;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done: ChatResponse | null = null;
  const handle = (chunk: string) => {
    const event = /^event: (.*)$/m.exec(chunk)?.[1];
    const data = /^data: (.*)$/m.exec(chunk)?.[1];
    if (!event || !data) return;
    const parsed = JSON.parse(data);
    if (event === "delta") onDelta(parsed.text);
    else if (event === "done") done = parsed as ChatResponse;
    else if (event === "error") throw new ApiError(parsed.statusCode ?? 502, parsed.message ?? "Barnaby lost his train of thought.");
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      handle(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) handle(buf);
  if (!done) throw new ApiError(502, "Barnaby's answer was cut off. Try again?");
  return done;
}

export const httpAiApi: AiApi = {
  status: () => request("/api/ai/status"),
  chat: (body) => request("/api/ai/chat", post(body)),
  chatStream,
  similar: (bookId, limit = 8) =>
    request<{ items: FoundBook[] }>(`/api/ai/books/${enc(bookId)}/similar?limit=${limit}`).then((r) => r.items),
  meaningSearch: (q, limit = 12) => request(`/api/ai/search?${new URLSearchParams({ q, limit: String(limit) })}`),
  smartRequest: (text, forKidId) => request("/api/ai/smart-request", post(forKidId ? { text, forKidId } : { text })),
  embeddings: () => request("/api/admin/ai/embeddings"),
  startEmbeddings: () => request("/api/admin/ai/embeddings/run", post({})),
  metadataStatus: () => request("/api/admin/ai/metadata/run"),
  startMetadata: (run) => request("/api/admin/ai/metadata/run", post(run)),
  metadataSuggestions: () =>
    // Inbox books show their fixes in the Inbox; this list is for books already in the library.
    request<{ items: MetadataSuggestion[] }>("/api/admin/ai/metadata/suggestions?scope=library").then((r) => r.items),
  acceptMetadata: (id, value) =>
    request(`/api/admin/ai/metadata/suggestions/${enc(id)}/accept`, post(value === undefined ? {} : { value })),
  dismissMetadata: (id) => request(`/api/admin/ai/metadata/suggestions/${enc(id)}/dismiss`, post({})),
  conversations: (bookId) =>
    request<{ items: AiConversation[] }>(`/api/ai/conversations${bookId ? `?bookId=${enc(bookId)}` : ""}`).then((r) => r.items),
  conversation: (id) => request(`/api/ai/conversations/${enc(id)}`),
  deleteConversation: (id) => request(`/api/ai/conversations/${enc(id)}`, { method: "DELETE" }),
  kids: () => request<{ items: KidAiRow[] }>("/api/ai/kids").then((r) => r.items),
  setKidSettings: (kidId, s) => request(`/api/ai/kids/${enc(kidId)}/settings`, { method: "PUT", body: JSON.stringify(s) }),
  kidConversations: (kidId) =>
    request<{ items: AiConversation[] }>(`/api/ai/kids/${enc(kidId)}/conversations`).then((r) => r.items),
  kidConversation: (kidId, id) => request(`/api/ai/kids/${enc(kidId)}/conversations/${enc(id)}`),
  settings: () => request("/api/admin/ai/settings"),
  saveSettings: (s) => request("/api/admin/ai/settings", { method: "PUT", body: JSON.stringify(s) }),
  testProvider: (providerId) => request("/api/admin/ai/providers/test", post({ providerId })),
  models: (providerId) => request<{ items: string[] }>(`/api/admin/ai/providers/${enc(providerId)}/models`).then((r) => r.items),
  testSearch: (q, kid) => request("/api/admin/ai/search/test", post({ q, kid })),
  ratingStatus: () => request("/api/admin/ai/rating/run"),
  startRating: (run) => request("/api/admin/ai/rating/run", post(run)),
  cancelJob: (jobId) => request(`/api/admin/jobs/${enc(jobId)}/cancel`, post({})),
  suggestions: () => request<{ items: RatingSuggestion[] }>("/api/admin/ai/rating/suggestions").then((r) => r.items),
  acceptSuggestion: (bookId, rating) =>
    request(`/api/admin/ai/rating/suggestions/${enc(bookId)}/accept`, post(rating ? { rating } : {})),
  dismissSuggestion: (bookId) => request(`/api/admin/ai/rating/suggestions/${enc(bookId)}/dismiss`, post({})),
};

// ---------------------------------------------------------------------------
// Demo: canned Barnaby answers built from the sample library (which already respects kid mode).
// ---------------------------------------------------------------------------

const demoKid = () => {
  try {
    return new URLSearchParams(location.search).get("demo") === "kid" || sessionStorage.getItem("bb-demo-user") === "kid";
  } catch {
    return false;
  }
};
const demoConvs = new Map<string, { conversation: AiConversation; messages: AiMessage[] }>();
let demoSent = 0;
const now = () => Date.now();
const id = () => Math.random().toString(36).slice(2);

const DEMO_SETTINGS: AiSettings = {
  providers: [
    {
      id: "ollama",
      name: "Ollama on the Unraid box",
      kind: "openai",
      baseUrl: "http://ollama:11434/v1",
      model: "llama3.2",
      hasApiKey: false,
    },
    {
      id: "guard",
      name: "Llama Guard",
      kind: "openai",
      baseUrl: "http://ollama:11434/v1",
      model: "llama-guard3:1b",
      hasApiKey: false,
    },
    { id: "claude", name: "Claude", kind: "anthropic", model: "claude-haiku-5-5", hasApiKey: true },
    {
      id: "embed",
      name: "Ollama embeddings",
      kind: "openai",
      baseUrl: "http://ollama:11434/v1",
      model: "nomic-embed-text",
      hasApiKey: false,
    },
  ],
  features: {
    chat: "claude",
    kidChat: "ollama",
    bookChat: "claude",
    moderation: "guard",
    rating: "ollama",
    metadata: "claude",
    embeddings: "embed",
  },
  search: {
    enabled: true,
    url: "http://searxng:8080",
    safeSearch: 1,
    kidAllowlist: ["kids.britannica.com", "natgeokids.com", "simple.wikipedia.org"],
    maxResults: 5,
  },
  moderation: { adults: false },
  kidDefaults: { dailyLimit: 30 },
  ratingHelper: { autoApprove: true, trustLooser: false, minConfidence: 0.8 },
};

async function demoReply(
  text: string,
  kid: boolean,
  web: boolean,
  bookId?: string,
): Promise<{ content: string; sources: AiSource[] }> {
  const lower = text.toLowerCase();
  if (bookId) {
    const b = await libraryApi.book(bookId);
    return {
      content: kid
        ? `I love "${b.title}"! 🦝 What's your favourite part so far? I won't tell you what happens next, that's the fun part!`
        : `Up to where you are in "${b.title}", the story has set up its main characters and their problem. I'll keep it spoiler-free: ask me about anything you've already read.`,
      sources: [],
    };
  }
  if (web && /volcano|space|planet|dinosaur|ocean/.test(lower)) {
    return {
      content: kid
        ? "Volcanoes are mountains with hot melted rock inside called magma! 🌋 When it bubbles up and comes out, it's called lava [1]."
        : "A volcano is an opening in the Earth's crust where molten rock, ash and gas escape [1]. Most sit where tectonic plates meet [2].",
      sources: [
        { kind: "web", title: "Volcano - Britannica Kids", url: "https://kids.britannica.com/kids/article/volcano/353907" },
        ...(kid
          ? []
          : [
              {
                kind: "web" as const,
                title: "Volcano - Simple English Wikipedia",
                url: "https://simple.wikipedia.org/wiki/Volcano",
              },
            ]),
      ],
    };
  }
  const page = await libraryApi.books(new URLSearchParams({ limit: "40" }));
  const words = lower.split(/\W+/).filter((w) => w.length > 3);
  const hits = page.items.filter((b) => words.some((w) => b.title.toLowerCase().includes(w)));
  const picks = (hits.length ? hits : page.items).slice(0, kid ? 2 : 3);
  const list = picks.map((b) => `"${b.title}"`).join(kid ? " or " : ", ");
  return {
    content: kid
      ? `Ooh, I found some for you! 📚 Try ${list}. Want me to tell you what they're about?`
      : `From your library, I'd borrow ${list}. Want a short pitch for each, or something in a different mood?`,
    sources: picks.map((b) => ({ kind: "book", title: b.title, bookId: b.id })),
  };
}

const DEMO_LOG: { conversation: AiConversation; messages: AiMessage[] }[] = [
  {
    conversation: {
      id: "k1",
      title: "Why do dinosaurs have feathers?",
      bookId: null,
      kid: true,
      flagged: false,
      createdAt: Date.parse("2026-11-13T17:02:00Z"),
      updatedAt: Date.parse("2026-11-13T17:04:00Z"),
    },
    messages: [
      {
        id: "m1",
        role: "user",
        content: "Why do dinosaurs have feathers?",
        moderation: null,
        createdAt: Date.parse("2026-11-13T17:02:00Z"),
        sources: [],
      },
      {
        id: "m2",
        role: "assistant",
        content:
          'Some dinosaurs had feathers to keep warm, like a cosy coat! 🦖 Birds today are their great-great-great… grandchildren. Want a dinosaur book? Try "The Dinosaur Who Loved Books"!',
        moderation: null,
        createdAt: Date.parse("2026-11-13T17:02:05Z"),
        sources: [{ kind: "book", title: "The Dinosaur Who Loved Books", bookId: "b1" }],
      },
    ],
  },
  {
    conversation: {
      id: "k2",
      title: "my school is",
      bookId: null,
      kid: true,
      flagged: true,
      createdAt: Date.parse("2026-11-12T16:10:00Z"),
      updatedAt: Date.parse("2026-11-12T16:11:00Z"),
    },
    messages: [
      {
        id: "m3",
        role: "user",
        content: "my phone is [removed: phone] can you call me",
        moderation: "redacted:phone",
        createdAt: Date.parse("2026-11-12T16:10:00Z"),
        sources: [],
      },
      {
        id: "m4",
        role: "assistant",
        content: "Let's keep things like your phone number private, even from me! 🦝 What else would you like to talk about?",
        moderation: null,
        createdAt: Date.parse("2026-11-12T16:10:04Z"),
        sources: [],
      },
      {
        id: "m5",
        role: "user",
        content: "what is a bad word",
        moderation: "blocked:profanity",
        createdAt: Date.parse("2026-11-12T16:11:00Z"),
        sources: [],
      },
      {
        id: "m6",
        role: "assistant",
        content: "That's a question for a grown-up you trust. 🦝 I'm best at books, stories and fun facts.",
        moderation: "canned",
        createdAt: Date.parse("2026-11-12T16:11:01Z"),
        sources: [],
      },
    ],
  },
];

const DEMO_METADATA: MetadataSuggestion[] = [
  {
    id: "md1",
    bookId: "b20",
    bookTitle: "Untitled Manuscript",
    field: "title",
    current: "Untitled Manuscript",
    suggested: "The Salt Road (draft)",
    reason: "The file name and first page give the real title.",
    status: "pending",
  },
  {
    id: "md2",
    bookId: "b17",
    bookTitle: "the_long_winter_road_v2 (retail)",
    field: "title",
    current: "the_long_winter_road_v2 (retail)",
    suggested: "The Long Winter Road",
    reason: "Removed file-name junk and fixed the capitals.",
    status: "pending",
  },
  {
    id: "md3",
    bookId: "b17",
    bookTitle: "the_long_winter_road_v2 (retail)",
    field: "authors",
    current: ["Lindqvist, Margot"],
    suggested: ["Margot Lindqvist"],
    reason: "Author names read first name first.",
    status: "pending",
  },
  {
    id: "md4",
    bookId: "b9",
    bookTitle: "Pixel Quest (Pixel Quest #1)",
    field: "series",
    current: null,
    suggested: { name: "Pixel Quest", position: 1 },
    reason: "The series was stuck in the title.",
    status: "pending",
  },
  {
    id: "md5",
    bookId: "b13",
    bookTitle: "Gardens of Ash",
    field: "description",
    current: "<p>A family saga.</p> ★★★★★ \"Unputdownable!\" Buy now and save 20%",
    suggested: "A family saga.",
    reason: "Removed HTML, a review quote and an ad.",
    status: "pending",
  },
];

export const demoAiApi: AiApi = {
  status: async () => {
    const kid = demoKid();
    return {
      available: true,
      reason: null,
      message: null,
      kid,
      webSearch: true,
      bookChat: true,
      remainingToday: kid ? 30 - demoSent : null,
      meaningSearch: true,
      smartRequests: !kid,
    };
  },
  chatStream: async (body, onDelta) => {
    const r = await demoAiApi.chat(body);
    if (demoKid()) return r;
    // Grown-ups see the reply appear a few words at a time, like the real thing.
    const words = r.reply.content.split(/(?<= )/);
    for (const w of words) {
      onDelta(w);
      await new Promise((ok) => setTimeout(ok, 25));
    }
    return r;
  },
  similar: async (bookId, limit = 8) => {
    const page = await libraryApi.books(new URLSearchParams({ limit: "60" }));
    const self = page.items.find((b) => b.id === bookId);
    const author = self?.authors?.[0]?.name;
    const series = self?.series?.[0]?.name;
    return page.items
      .filter((b) => b.id !== bookId)
      .map((b, i) => {
        const sameSeries = !!series && b.series?.some((s) => s.name === series);
        const sameAuthor = !!author && b.authors?.some((a) => a.name === author);
        const sameAge = b.rating === self?.rating;
        const score = (sameSeries ? 3 : 0) + (sameAuthor ? 2 : 0) + (sameAge ? 1 : 0) - i * 0.01;
        const reason = sameSeries ? `Same series: ${series}` : sameAuthor ? `Also by ${author}` : sameAge ? "A similar story" : "Also in your library";
        return { ...b, reason, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  },
  meaningSearch: async (q, limit = 12) => {
    await new Promise((r) => setTimeout(r, 300));
    const page = await libraryApi.books(new URLSearchParams({ limit: "60" }));
    const lower = q.toLowerCase();
    const plots: [RegExp, RegExp][] = [
      [/robot|machine|neighbo|friend/, /robot/i],
      [/sea|ocean|light|storm|island|coast/, /lighthouse|sea/i],
      [/sleep|bed|night|tired|moon/, /goodnight|sleepy|moon/i],
      [/game|video|level|arcade|computer/, /pixel/i],
      [/snow|winter|cold|journey|road/, /winter|road/i],
      [/dino|fossil|dig/, /dinosaur/i],
      [/cook|soup|dinner|recipe/, /soup/i],
      [/japan|travel|quiet|calm/, /kyoto|quiet/i],
    ];
    const wanted = plots.filter(([q]) => q.test(lower)).map(([, t]) => t);
    const items = page.items
      .filter((b) => wanted.some((t) => t.test(b.title)))
      .map((b, i) => ({ ...b, score: Math.round((0.82 - i * 0.05) * 100) / 100 }))
      .slice(0, limit);
    return { available: true, items };
  },
  smartRequest: async (text) => {
    await new Promise((r) => setTimeout(r, 600));
    const age = Number(/(\d+)[- ]?year/.exec(text)?.[1]) || null;
    const max = age == null ? "adult" : age < 8 ? "kids" : age < 13 ? "middle_grade" : age < 18 ? "teen" : "adult";
    const order = ["kids", "middle_grade", "teen", "adult", "explicit"];
    const page = await libraryApi.books(new URLSearchParams({ limit: "60" }));
    // Closest to the age asked for first.
    const fits = page.items
      .filter((b) => b.rating && order.indexOf(b.rating) <= order.indexOf(max))
      .sort((a, b) => order.indexOf(b.rating!) - order.indexOf(a.rating!));
    const like = /like ([A-Z][\w' :]+?)(?: for| about|$)/.exec(text)?.[1]?.trim();
    const reasons = [
      "A big-hearted adventure with the same mix of humour and puzzles.",
      "Short chapters and a brave hero who solves problems with friends.",
      "Gentle peril and lots of heart, just right for that age.",
      "Funny, fast and full of surprises.",
    ];
    return {
      interpreted: { like: like ? [like] : [], age, topics: ["adventure", "friendship"], maxRating: max, forKid: null },
      picks: fits
        .filter((b) => b.title !== like)
        .slice(0, 4)
        .map((b, i) => ({ ...b, reason: reasons[i % reasons.length]! })),
      outside: [
        { title: "The Wild Robot", author: "Peter Brown", reason: "A robot learns to survive on a wild island; loved by 8 to 12 year olds." },
        { title: "Zita the Spacegirl", author: "Ben Hatke", reason: "A graphic-novel space adventure full of friendly monsters." },
      ],
    };
  },
  embeddings: async () => ({
    configured: true,
    model: "nomic-embed-text",
    indexed: 22,
    total: 24,
    job: { id: "j1", status: "running", progress: 0.6, lastError: null, finishedAt: null },
  }),
  startEmbeddings: async () => demoAiApi.embeddings(),
  metadataStatus: async () => ({
    running: false,
    total: 25,
    done: 25,
    suggested: 3,
    applied: 5,
    failed: 2,
    lastError: "Couldn't read the model's suggestions for \"Scan 0042\"",
    progress: { total: 902, remaining: 412, waiting: 3, fixes: 5, failed: 2 },
    estimate: { provider: "Claude", model: "claude-sonnet-5-5", source: "table", free: false, perBook: 0.0049, basis: "history" },
    spent: { dollars: 2.39, calls: 488, partial: false },
  }),
  startMetadata: async () => ({ running: true, total: 25, done: 0, suggested: 0, applied: 0, failed: 0, lastError: null }),
  metadataSuggestions: async () => structuredClone(DEMO_METADATA),
  acceptMetadata: async (mid) => void DEMO_METADATA.splice(DEMO_METADATA.findIndex((m) => m.id === mid), 1),
  dismissMetadata: async (mid) => void DEMO_METADATA.splice(DEMO_METADATA.findIndex((m) => m.id === mid), 1),
  chat: async (body) => {
    const kid = demoKid();
    await new Promise((r) => setTimeout(r, 700));
    let entry = body.conversationId ? demoConvs.get(body.conversationId) : undefined;
    if (!entry) {
      entry = {
        conversation: {
          id: id(),
          title: body.message.slice(0, 60),
          bookId: body.bookId ?? null,
          kid,
          flagged: false,
          createdAt: now(),
          updatedAt: now(),
        },
        messages: [],
      };
      demoConvs.set(entry.conversation.id, entry);
    }
    const r = await demoReply(body.message, kid, !!body.webSearch, entry.conversation.bookId ?? undefined);
    const message: AiMessage = { id: id(), role: "user", content: body.message, moderation: null, createdAt: now(), sources: [] };
    const reply: AiMessage = {
      id: id(),
      role: "assistant",
      content: r.content,
      moderation: null,
      createdAt: now(),
      sources: r.sources,
    };
    entry.messages.push(message, reply);
    if (kid) demoSent++;
    return {
      conversationId: entry.conversation.id,
      message,
      reply,
      remainingToday: kid ? 30 - demoSent : null,
      searchError: null,
    };
  },
  conversations: async (bookId) =>
    [...demoConvs.values()]
      .map((c) => c.conversation)
      .filter((c) => !bookId || c.bookId === bookId)
      .reverse(),
  conversation: async (cid) => {
    const c = demoConvs.get(cid);
    if (!c) throw new ApiError(404, "Not found");
    return c;
  },
  deleteConversation: async (cid) => void demoConvs.delete(cid),
  kids: async () => [
    {
      id: "u-kid",
      displayName: "Mia",
      avatar: "🦖",
      age: 7,
      settings: { enabled: true, webSearch: false, dailyLimit: 30, updatedAt: now() },
      status: "on",
      sentToday: 4,
      flaggedConversations: 1,
    },
    {
      id: "u-kid2",
      displayName: "Theo",
      avatar: "🚀",
      age: 4,
      settings: { enabled: false, webSearch: false, dailyLimit: 30, updatedAt: null },
      status: "too_young",
      sentToday: 0,
      flaggedConversations: 0,
    },
  ],
  setKidSettings: async (_k, s) => ({ ...s, updatedAt: now() }),
  kidConversations: async () => DEMO_LOG.map((c) => c.conversation),
  kidConversation: async (_k, cid) => DEMO_LOG.find((c) => c.conversation.id === cid) ?? DEMO_LOG[0]!,
  settings: async () => structuredClone(DEMO_SETTINGS),
  saveSettings: async (s) => s,
  testProvider: async () => ({ ok: true, reply: "Hello, fellow book lover!", model: "llama3.2", ms: 840 }),
  models: async () => ["llama3.2", "llama3.1:8b", "llama-guard3:1b", "qwen2.5:7b"],
  testSearch: async () => ({
    ok: true,
    items: [{ title: "Dinosaur - Britannica Kids", url: "https://kids.britannica.com/kids/article/dinosaur/353043" }],
  }),
  ratingStatus: async () => ({
    jobId: "demo-rating",
    running: true,
    total: 290,
    done: 112,
    suggested: 112,
    applied: 9,
    failed: 0,
    lastError: null,
    progress: { total: 902, remaining: 178, waiting: 487, failed: 2 },
    estimate: { provider: "Ollama", model: "llama3.2", source: "local", free: true, perBook: 0, basis: "history" },
    spent: { dollars: 0, calls: 726, partial: false },
  }),
  startRating: async () => ({ running: true, total: 3, done: 0, suggested: 0, applied: 0, failed: 0, lastError: null }),
  cancelJob: async () => {},
  suggestions: async () => [
    {
      bookId: "b3",
      title: "Barnaby and the Missing Page",
      rating: "kids",
      confidence: 0.92,
      reasons: "A gentle picture-book mystery for early readers.",
      currentRating: null,
      status: "pending",
    },
    {
      bookId: "b6",
      title: "The Robot Next Door",
      rating: "middle_grade",
      confidence: 0.8,
      reasons: "School-age friendship story with mild peril.",
      currentRating: null,
      status: "pending",
    },
  ],
  acceptSuggestion: async () => {},
  dismissSuggestion: async () => {},
};

export const aiApi: AiApi = isDemo ? demoAiApi : httpAiApi;
