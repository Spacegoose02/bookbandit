/**
 * Admin → Connections → Single sign-on: set up Tinyauth (or any OpenID Connect provider) in the
 * browser instead of with env vars.
 *
 * Stored in the `settings` table under `auth.sso`; the client secret is sealed with the same
 * SecretBox as the integrations' keys and never returned (only `hasClientSecret`). Each stored
 * value wins over its env var (SSO_LABEL, SSO_ISSUER, SSO_CLIENT_ID, SSO_CLIENT_SECRET, PUBLIC_URL,
 * SSO_AUTO_CREATE); anything left empty falls back to the env var. Read on every request, so a
 * save takes effect without a restart.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { SecretBox } from "../integrations/secrets.js";
import { requireAdmin } from "./plugin.js";
import { useAuthErrors } from "./errors.js";
import { parseScopes, requestOrigin, SSO_CALLBACK_PATH, type SsoConfig } from "./oidc.js";

export const SSO_SETTINGS_KEY = "auth.sso";

export type SsoEnv = Pick<Config, "SSO_ISSUER" | "SSO_CLIENT_ID" | "SSO_CLIENT_SECRET" | "PUBLIC_URL" | "SSO_LABEL"> & {
  SSO_AUTO_CREATE?: boolean;
};

interface Stored {
  label?: string;
  issuer?: string;
  clientId?: string;
  /** Sealed with the SecretBox. */
  clientSecret?: string;
  publicUrl?: string;
  scopes?: string[];
  autoCreate?: boolean;
  showOnSignIn?: boolean;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");
const url = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^https?:\/\/[^\s/]+/i.test(v), "Use a full address starting with https://");

export const SsoSettingsInput = z
  .object({
    label: z.string().trim().max(40).default(""),
    issuer: url.default(""),
    clientId: z.string().trim().max(500).default(""),
    /** A new secret, null to forget the saved one, or omitted to keep it. */
    clientSecret: z.string().trim().min(1).max(4000).nullable().optional(),
    publicUrl: url.default(""),
    scopes: z.string().max(500).default(""),
    autoCreate: z.boolean(),
    showOnSignIn: z.boolean(),
  })
  .strict();

function readStored(db: Db): Stored | null {
  const row = db.select().from(settings).where(eq(settings.key, SSO_SETTINGS_KEY)).get();
  return row ? (row.value as Stored) : null;
}

/** What single sign-on uses right now: admin settings over env vars. Null = off. */
export function resolveSso(db: Db, box: SecretBox, env: SsoEnv): SsoConfig | null {
  const s = readStored(db);
  let secret = env.SSO_CLIENT_SECRET;
  if (s?.clientSecret) {
    try {
      secret = box.open(s.clientSecret);
    } catch {
      secret = undefined; // the key file changed; the admin has to paste the secret again
    }
  }
  const issuer = s?.issuer || env.SSO_ISSUER;
  const clientId = s?.clientId || env.SSO_CLIENT_ID;
  if (!issuer || !clientId || !secret) return null;
  return {
    issuer: trimSlash(issuer),
    clientId,
    clientSecret: secret,
    publicUrl: s?.publicUrl || env.PUBLIC_URL ? trimSlash((s?.publicUrl || env.PUBLIC_URL)!) : undefined,
    label: s?.label || env.SSO_LABEL?.trim() || "Tinyauth",
    autoCreate: s?.autoCreate ?? env.SSO_AUTO_CREATE ?? true,
    scopes: s?.scopes ?? [],
    showOnSignIn: s?.showOnSignIn ?? true,
  };
}

export async function ssoSettingsRoutes(
  app: FastifyInstance,
  opts: { db: Db; box: SecretBox; env: SsoEnv; trustedProxies: string[]; fetchImpl?: typeof fetch },
) {
  const { db, box, env } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  useAuthErrors(app);

  function view(origin: string) {
    const s = readStored(db);
    const active = resolveSso(db, box, env);
    const publicUrl = s?.publicUrl || env.PUBLIC_URL || "";
    return {
      active: !!active,
      label: s?.label || env.SSO_LABEL || "",
      issuer: s?.issuer || env.SSO_ISSUER || "",
      clientId: s?.clientId || env.SSO_CLIENT_ID || "",
      hasClientSecret: !!(s?.clientSecret || env.SSO_CLIENT_SECRET),
      publicUrl,
      scopes: (s?.scopes ?? []).join(" "),
      autoCreate: s?.autoCreate ?? env.SSO_AUTO_CREATE ?? true,
      showOnSignIn: s?.showOnSignIn ?? true,
      /** Paste this into the provider as the redirect / callback URL. */
      callbackUrl: `${trimSlash(publicUrl || origin)}${SSO_CALLBACK_PATH}`,
      /** Values the container's env vars provide; leaving a field empty falls back to these. */
      fromEnv: {
        label: !!env.SSO_LABEL,
        issuer: !!env.SSO_ISSUER,
        clientId: !!env.SSO_CLIENT_ID,
        clientSecret: !!env.SSO_CLIENT_SECRET,
        publicUrl: !!env.PUBLIC_URL,
      },
      saved: !!s,
    };
  }

  app.get("/api/admin/settings/sso", async (req) => {
    requireAdmin(req);
    return view(requestOrigin(req, opts.trustedProxies));
  });

  app.put("/api/admin/settings/sso", async (req) => {
    requireAdmin(req);
    const body = SsoSettingsInput.parse(req.body);
    const cur = readStored(db);
    const next: Stored = {
      label: body.label || undefined,
      issuer: body.issuer ? trimSlash(body.issuer) : undefined,
      clientId: body.clientId || undefined,
      clientSecret:
        body.clientSecret === undefined ? cur?.clientSecret : body.clientSecret === null ? undefined : box.seal(body.clientSecret),
      publicUrl: body.publicUrl ? trimSlash(body.publicUrl) : undefined,
      scopes: parseScopes(body.scopes),
      autoCreate: body.autoCreate,
      showOnSignIn: body.showOnSignIn,
    };
    const now = Date.now();
    db.insert(settings)
      .values({ key: SSO_SETTINGS_KEY, value: next, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: now } })
      .run();
    return view(requestOrigin(req, opts.trustedProxies));
  });

  /** Forget everything saved here; the env vars (if any) apply again. */
  app.delete("/api/admin/settings/sso", async (req) => {
    requireAdmin(req);
    db.delete(settings).where(eq(settings.key, SSO_SETTINGS_KEY)).run();
    return view(requestOrigin(req, opts.trustedProxies));
  });

  /** Check that an issuer answers OpenID Connect discovery, before or after saving. */
  app.post("/api/admin/settings/sso/test", async (req) => {
    requireAdmin(req);
    const { issuer } = z.object({ issuer: url }).strict().parse(req.body);
    const target = trimSlash(issuer || resolveSso(db, box, env)?.issuer || "");
    if (!target) return { ok: false, error: "Enter the issuer URL first." };
    try {
      const res = await fetchImpl(`${target}/.well-known/openid-configuration`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, error: `${target} answered ${res.status}. Is this the Tinyauth address?` };
      const d = (await res.json()) as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string };
      if (!d.authorization_endpoint || !d.token_endpoint) return { ok: false, error: "That address isn't an OpenID Connect provider." };
      return { ok: true, issuer: d.issuer ?? target };
    } catch (e) {
      return { ok: false, error: `Couldn't reach ${target}: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
}
