/**
 * Barnaby's admin settings, one JSON value in the `settings` table under `ai.settings`.
 * API keys are sealed with the integrations SecretBox and never sent back to clients.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { SecretBox } from "../integrations/secrets.js";
import { PROVIDER_KINDS, type ProviderConfig } from "./providers/types.js";

export const AI_SETTINGS_KEY = "ai.settings";

/** Each feature picks its own provider (or none = feature off). */
export const AI_FEATURES = ["chat", "kidChat", "bookChat", "moderation", "rating", "metadata", "embeddings"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be http(s)")
  .transform((u) => u.replace(/\/+$/, ""));

const ProviderInput = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "lower-case letters, digits, - and _"),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(PROVIDER_KINDS),
  baseUrl: httpUrl.optional(),
  model: z.string().trim().min(1).max(200),
  /** Omit to keep the stored key; null or "" removes it. */
  apiKey: z.string().max(500).nullable().optional(),
  timeoutMs: z.number().int().min(5_000).max(600_000).optional(),
});

const providerRef = z.string().nullable().default(null);

export const AiSettingsInput = z
  .object({
    providers: z.array(ProviderInput).max(20).default([]),
    features: z
      .object({
        chat: providerRef,
        kidChat: providerRef,
        bookChat: providerRef,
        moderation: providerRef,
        rating: providerRef,
        /** Metadata cleanup suggestions. Falls back to the grown-up chat provider. */
        metadata: providerRef,
        /** Meaning search and "more like this". Needs an embeddings model (Ollama nomic-embed-text). */
        embeddings: providerRef,
      })
      .prefault({}),
    search: z
      .object({
        enabled: z.boolean().default(false),
        /** SearXNG base URL, e.g. http://searxng:8080 */
        url: httpUrl.optional(),
        /** Adults: 0 off, 1 moderate, 2 strict. Kids are always 2. */
        safeSearch: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
        /** Sites kid answers may cite. A result is kept when its host is one of these or a subdomain. */
        kidAllowlist: z.array(z.string().trim().toLowerCase().min(3).max(100)).max(200).default(DEFAULT_KID_ALLOWLIST()),
        maxResults: z.number().int().min(1).max(10).default(5),
      })
      .prefault({}),
    moderation: z
      .object({
        /** Also moderate grown-ups' chats (kids are always moderated). */
        adults: z.boolean().default(false),
      })
      .prefault({}),
    kidDefaults: z
      .object({
        dailyLimit: z.number().int().min(1).max(500).default(30),
      })
      .prefault({}),
  })
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    s.providers.forEach((p, i) => {
      if (ids.has(p.id)) ctx.addIssue({ code: "custom", path: ["providers", i, "id"], message: "duplicate id" });
      ids.add(p.id);
      if (p.kind === "openai" && !p.baseUrl)
        ctx.addIssue({ code: "custom", path: ["providers", i, "baseUrl"], message: "required for OpenAI-compatible servers" });
    });
    for (const f of AI_FEATURES) {
      const ref = s.features[f];
      if (ref && !ids.has(ref)) ctx.addIssue({ code: "custom", path: ["features", f], message: `unknown provider "${ref}"` });
    }
    if (s.search.enabled && !s.search.url) ctx.addIssue({ code: "custom", path: ["search", "url"], message: "required when search is on" });
  });
export type AiSettingsInput = z.input<typeof AiSettingsInput>;

function DEFAULT_KID_ALLOWLIST(): string[] {
  return [
    "kids.britannica.com",
    "kids.nationalgeographic.com",
    "natgeokids.com",
    "dkfindout.com",
    "wonderopolis.org",
    "kiddle.co",
    "spaceplace.nasa.gov",
    "simple.wikipedia.org",
    "ducksters.com",
    "sciencekids.co.nz",
  ];
}

export interface AiSettings {
  providers: ProviderConfig[];
  features: Record<AiFeature, string | null>;
  search: { enabled: boolean; url?: string; safeSearch: 0 | 1 | 2; kidAllowlist: string[]; maxResults: number };
  moderation: { adults: boolean };
  kidDefaults: { dailyLimit: number };
}

export function defaultSettings(): AiSettings {
  return AiSettingsInput.parse({}) as AiSettings;
}

export function getAiSettings(db: Db, box: SecretBox): AiSettings {
  const row = db.select().from(settings).where(eq(settings.key, AI_SETTINGS_KEY)).get();
  if (!row) return defaultSettings();
  const stored = row.value as AiSettings;
  const defaults = defaultSettings();
  return {
    ...defaults,
    ...stored,
    // Settings saved before a feature existed don't have its key.
    features: { ...defaults.features, ...stored.features },
    providers: stored.providers.map((p) => ({ ...p, apiKey: p.apiKey ? box.open(p.apiKey) : undefined })),
  };
}

export function saveAiSettings(db: Db, box: SecretBox, raw: unknown): AiSettings {
  const input = AiSettingsInput.parse(raw);
  const current = getAiSettings(db, box);
  const providers: ProviderConfig[] = input.providers.map((p) => {
    const old = current.providers.find((c) => c.id === p.id);
    const apiKey = p.apiKey === undefined ? old?.apiKey : p.apiKey || undefined;
    const { apiKey: _drop, ...rest } = p;
    return { ...rest, ...(apiKey ? { apiKey } : {}) };
  });
  const next: AiSettings = { ...input, providers } as AiSettings;
  const stored = { ...next, providers: providers.map((p) => (p.apiKey ? { ...p, apiKey: box.seal(p.apiKey) } : p)) };
  const now = Date.now();
  db.insert(settings)
    .values({ key: AI_SETTINGS_KEY, value: stored, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: stored, updatedAt: now } })
    .run();
  return next;
}

/** What admins see: everything but the keys. */
export function publicAiSettings(s: AiSettings) {
  return {
    ...s,
    providers: s.providers.map(({ apiKey, ...p }) => ({ ...p, hasApiKey: !!apiKey })),
  };
}

export function providerFor(s: AiSettings, feature: AiFeature): ProviderConfig | null {
  // Book chat, kid chat and metadata cleanup fall back to the general chat provider when not set separately.
  const id = s.features[feature] ?? (feature === "bookChat" || feature === "kidChat" || feature === "metadata" ? s.features.chat : null);
  return id ? (s.providers.find((p) => p.id === id) ?? null) : null;
}
