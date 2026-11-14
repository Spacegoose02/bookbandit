/**
 * Narration server settings (admin only). One OpenAI-compatible text-to-speech server:
 * Kokoro-FastAPI (`http://kokoro:8880/v1`) or Piper behind an OpenAI-style `/v1/audio/speech`
 * (for example openedai-speech). Stored in the `settings` table; the API key is sealed.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { SecretBox } from "../integrations/secrets.js";

export const NARRATION_SETTINGS_KEY = "narration.settings";

export const NarrationSettingsInput = z.object({
  enabled: z.boolean().default(false),
  /** Up to and including /v1, e.g. http://kokoro:8880/v1 */
  baseUrl: z.string().url().max(500).optional(),
  model: z.string().min(1).max(100).default("kokoro"),
  /** undefined keeps the stored key, "" clears it. */
  apiKey: z.string().max(500).optional(),
  defaultVoice: z.string().min(1).max(100).default("af_heart"),
  /** Voice for kids who haven't picked one (falls back to defaultVoice). */
  kidVoice: z.string().min(1).max(100).nullable().default(null),
  /** Voices people can pick from when the server can't list its own. */
  voices: z.array(z.string().min(1).max(100)).max(200).default([]),
  /** Kokoro-FastAPI: ask /dev/captioned_speech for word timings (exact word highlighting). */
  wordTimings: z.boolean().default(true),
  /** Disk cache for spoken audio, in MB. Oldest clips go first. */
  cacheMb: z.number().int().min(10).max(50_000).default(500),
  timeoutMs: z.number().int().min(2_000).max(300_000).default(60_000),
});

export type NarrationSettings = Omit<z.output<typeof NarrationSettingsInput>, "apiKey"> & { apiKey?: string };

export function defaultNarrationSettings(): NarrationSettings {
  return NarrationSettingsInput.parse({});
}

export function getNarrationSettings(db: Db, box: SecretBox): NarrationSettings {
  const row = db.select().from(settings).where(eq(settings.key, NARRATION_SETTINGS_KEY)).get();
  if (!row) return defaultNarrationSettings();
  const stored = row.value as NarrationSettings;
  return { ...defaultNarrationSettings(), ...stored, apiKey: stored.apiKey ? box.open(stored.apiKey) : undefined };
}

export function saveNarrationSettings(db: Db, box: SecretBox, raw: unknown): NarrationSettings {
  const input = NarrationSettingsInput.parse(raw);
  const current = getNarrationSettings(db, box);
  const apiKey = input.apiKey === undefined ? current.apiKey : input.apiKey || undefined;
  if (input.enabled && !input.baseUrl) throw Object.assign(new Error("Add the speech server's address first"), { statusCode: 400 });
  const next: NarrationSettings = { ...input, apiKey };
  const stored = { ...next, apiKey: apiKey ? box.seal(apiKey) : undefined };
  const now = Date.now();
  db.insert(settings)
    .values({ key: NARRATION_SETTINGS_KEY, value: stored, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: stored, updatedAt: now } })
    .run();
  return next;
}

/** What admins see: everything but the key. */
export function publicNarrationSettings(s: NarrationSettings) {
  const { apiKey, ...rest } = s;
  return { ...rest, hasApiKey: !!apiKey };
}
