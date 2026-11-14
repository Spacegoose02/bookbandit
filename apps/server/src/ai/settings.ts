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

/** Adds http:// to a bare host ("192.168.1.5:8080", "ollama:11434/v1"); blank means not set. */
export function normalizeUrl(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
}

const httpUrl = z.preprocess(
  normalizeUrl,
  z
    .string()
    .url("isn't a valid web address")
    .refine((u) => /^https?:\/\//i.test(u), "must start with http:// or https://")
    .transform((u) => u.replace(/\/+$/, ""))
    // Blank becomes undefined above, which every URL field allows (the superRefine says when one is required).
    .optional(),
);

const FIELD_LABELS: Record<string, string> = {
  baseUrl: "base URL",
  model: "model",
  name: "name",
  id: "id",
  apiKey: "API key",
  timeoutMs: "timeout",
  kind: "kind",
};

/** "SearXNG URL isn't a valid web address", "Provider “Ollama” base URL: required…", for a settings form. */
export function describeSettingsIssue(issue: { path: (string | number)[]; message: string }, body: unknown): string {
  const [a, b, c] = issue.path;
  let where = issue.path.join(".");
  if (a === "search" && b === "url") where = "SearXNG URL";
  else if (a === "search" && b === "kidAllowlist") where = "Kid sites list";
  else if (a === "providers" && typeof b === "number") {
    const p = (body as { providers?: { name?: string; id?: string }[] } | null)?.providers?.[b];
    const label = p?.name || p?.id || `#${b + 1}`;
    where = `Provider “${label}”${c ? ` ${FIELD_LABELS[String(c)] ?? String(c)}` : ""}`;
  } else if (a === "features" && b) where = `“${String(b)}” provider`;
  else if (a === "kidDefaults") where = "Kids' daily limit";
  return `${where}: ${issue.message}`;
}

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
  /** $ per million tokens, for cost estimates. Omit to use the built-in table. */
  price: z.object({ input: z.number().min(0).max(1000), output: z.number().min(0).max(1000) }).optional(),
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
    /** What happens to a book once the rating helper has looked at it (ai/review.ts). */
    ratingHelper: z
      .object({
        /** Approve rated books out of the Inbox (likely copies stay). Approval alone shows nothing to kids: unrated counts as adult. */
        autoApprove: z.boolean().default(true),
        /** Apply a looser rating (one that shows the book to kids) without asking. Off: it waits on "Needs a rating". */
        trustLooser: z.boolean().default(false),
        /** How sure Barnaby has to be for `trustLooser`. */
        minConfidence: z.number().min(0.5).max(1).default(0.8),
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
    const emb = s.providers.find((p) => p.id === s.features.embeddings);
    if (emb && !canEmbed(emb))
      ctx.addIssue({ code: "custom", path: ["features", "embeddings"], message: "Claude has no embeddings API; pick Ollama, OpenAI or Gemini" });
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

/** Anthropic has no embeddings API, so a Claude provider can't do meaning search. */
export const canEmbed = (p: Pick<ProviderConfig, "kind">) => p.kind !== "anthropic";

export interface AiSettings {
  providers: ProviderConfig[];
  features: Record<AiFeature, string | null>;
  search: { enabled: boolean; url?: string; safeSearch: 0 | 1 | 2; kidAllowlist: string[]; maxResults: number };
  moderation: { adults: boolean };
  kidDefaults: { dailyLimit: number };
  ratingHelper: { autoApprove: boolean; trustLooser: boolean; minConfidence: number };
}

export function defaultSettings(): AiSettings {
  return AiSettingsInput.parse({}) as AiSettings;
}

export function getAiSettings(db: Db, box: SecretBox): AiSettings {
  const row = db.select().from(settings).where(eq(settings.key, AI_SETTINGS_KEY)).get();
  if (!row) return defaultSettings();
  const stored = row.value as AiSettings;
  const defaults = defaultSettings();
  // Settings saved before a feature existed don't have its key.
  const features = { ...defaults.features, ...stored.features };
  // Older saves could point meaning search at Claude, which can't embed: treat that as off.
  const emb = stored.providers.find((p) => p.id === features.embeddings);
  if (emb && !canEmbed(emb)) features.embeddings = null;
  return {
    ...defaults,
    ...stored,
    features,
    ratingHelper: { ...defaults.ratingHelper, ...stored.ratingHelper },
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
