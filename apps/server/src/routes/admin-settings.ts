/**
 * Admin settings for online metadata lookup (Hardcover, Google Books, Open Library), so the
 * admin can turn it on or off and paste API keys in the browser instead of editing env vars.
 *
 * Stored in the `settings` table under `metadata.lookup`; keys are sealed with the same
 * SecretBox as the integrations and never returned (only `hasHardcoverToken` etc.).
 * When nothing is stored, the env vars (METADATA_ONLINE, HARDCOVER_API_TOKEN,
 * GOOGLE_BOOKS_API_KEY) apply, and a stored key wins over the env one.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import { requireAdmin } from "../auth/plugin.js";
import { useAuthErrors } from "../auth/errors.js";
import type { SecretBox } from "../integrations/secrets.js";
import type { LookupOptions } from "../metadata/lookup.js";

export const METADATA_KEY = "metadata.lookup";

interface Stored {
  online: boolean;
  hardcoverToken?: string;
  googleApiKey?: string;
}

/** A key: a new value, null to clear the stored one, or omitted to keep it. */
const key = z.string().trim().min(1).max(4000).nullable().optional();
export const MetadataSettingsInput = z.object({ online: z.boolean(), hardcoverToken: key, googleApiKey: key }).strict();

function readStored(db: Db): Stored | null {
  const row = db.select().from(settings).where(eq(settings.key, METADATA_KEY)).get();
  return row ? (row.value as Stored) : null;
}

type EnvPart = Pick<Config, "METADATA_ONLINE" | "HARDCOVER_API_TOKEN" | "GOOGLE_BOOKS_API_KEY">;

/** What lookups use right now: stored settings over env vars. false = online lookup off. */
export function resolveLookup(db: Db, box: SecretBox, env: EnvPart, extra: Partial<LookupOptions> = {}): LookupOptions | false {
  const s = readStored(db);
  const online = s ? s.online : env.METADATA_ONLINE;
  if (!online) return false;
  return {
    hardcoverToken: s?.hardcoverToken ? box.open(s.hardcoverToken) : env.HARDCOVER_API_TOKEN,
    googleApiKey: s?.googleApiKey ? box.open(s.googleApiKey) : env.GOOGLE_BOOKS_API_KEY,
    ...extra,
  };
}

export function publicMetadataSettings(db: Db, env: EnvPart) {
  const s = readStored(db);
  return {
    online: s ? s.online : env.METADATA_ONLINE,
    hasHardcoverToken: !!(s?.hardcoverToken || env.HARDCOVER_API_TOKEN),
    hasGoogleApiKey: !!(s?.googleApiKey || env.GOOGLE_BOOKS_API_KEY),
    /** Keys that come from env vars; clearing the stored key falls back to these. */
    fromEnv: { hardcoverToken: !!env.HARDCOVER_API_TOKEN, googleApiKey: !!env.GOOGLE_BOOKS_API_KEY },
    saved: !!s,
  };
}

export async function adminSettingsRoutes(app: FastifyInstance, opts: { db: Db; box: SecretBox; config: EnvPart }) {
  const { db, box, config } = opts;
  useAuthErrors(app);

  app.get("/api/admin/settings/metadata", async (req) => {
    requireAdmin(req);
    return publicMetadataSettings(db, config);
  });

  app.put("/api/admin/settings/metadata", async (req) => {
    requireAdmin(req);
    const body = MetadataSettingsInput.parse(req.body);
    const cur = readStored(db);
    const pick = (input: string | null | undefined, stored: string | undefined) =>
      input === undefined ? stored : input === null ? undefined : box.seal(input);
    const next: Stored = {
      online: body.online,
      hardcoverToken: pick(body.hardcoverToken, cur?.hardcoverToken),
      googleApiKey: pick(body.googleApiKey, cur?.googleApiKey),
    };
    const now = Date.now();
    db.insert(settings)
      .values({ key: METADATA_KEY, value: next, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: now } })
      .run();
    return publicMetadataSettings(db, config);
  });
}
