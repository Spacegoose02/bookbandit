/**
 * Barnaby's API client. Endpoints are documented in docs/ai.md; the demo version below
 * answers from the sample library so the chat can be shown without a server or model.
 */
import { api as libraryApi, ApiError, isDemo } from "../api/client";

export interface AiStatus {
  available: boolean;
  reason: "not_configured" | "off" | "too_young" | "no_birth_year" | "daily_limit" | null;
  message: string | null;
  kid: boolean;
  webSearch: boolean;
  bookChat: boolean;
  remainingToday: number | null;
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
  hasApiKey?: boolean;
  /** Only sent when changing it; "" removes it. */
  apiKey?: string | null;
}

export const AI_FEATURES = ["chat", "kidChat", "bookChat", "moderation", "rating"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export interface AiSettings {
  providers: ProviderSettings[];
  features: Record<AiFeature, string | null>;
  search: { enabled: boolean; url?: string; safeSearch: 0 | 1 | 2; kidAllowlist: string[]; maxResults: number };
  moderation: { adults: boolean };
  kidDefaults: { dailyLimit: number };
}

export interface RatingRunStatus {
  running: boolean;
  total: number;
  done: number;
  suggested: number;
  applied: number;
  failed: number;
  lastError: string | null;
}

export interface RatingSuggestion {
  bookId: string;
  title: string;
  rating: string;
  confidence: number;
  reasons: string;
  currentRating: string | null;
  status: string;
}

export interface AiApi {
  status(): Promise<AiStatus>;
  chat(body: { message: string; conversationId?: string; bookId?: string; webSearch?: boolean }): Promise<ChatResponse>;
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
  startRating(limit: number): Promise<RatingRunStatus>;
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

export const httpAiApi: AiApi = {
  status: () => request("/api/ai/status"),
  chat: (body) => request("/api/ai/chat", post(body)),
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
  startRating: (limit) => request("/api/admin/ai/rating/run", post({ limit })),
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
  ],
  features: { chat: "claude", kidChat: "ollama", bookChat: "claude", moderation: "guard", rating: "ollama" },
  search: {
    enabled: true,
    url: "http://searxng:8080",
    safeSearch: 1,
    kidAllowlist: ["kids.britannica.com", "natgeokids.com", "simple.wikipedia.org"],
    maxResults: 5,
  },
  moderation: { adults: false },
  kidDefaults: { dailyLimit: 30 },
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
    };
  },
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
  ratingStatus: async () => ({ running: false, total: 3, done: 3, suggested: 3, applied: 1, failed: 0, lastError: null }),
  startRating: async () => ({ running: true, total: 3, done: 0, suggested: 0, applied: 0, failed: 0, lastError: null }),
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
