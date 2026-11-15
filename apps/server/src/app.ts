import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { authPlugin } from "./auth/plugin.js";
import { parseTrustedProxies } from "./auth/trusted-proxy.js";
import { authRoutes } from "./auth/routes.js";
import { loadSessionSecret, SessionSigner } from "./auth/sessions.js";
import { SSO_START_PATH, ssoConfigFrom, ssoRoutes, type SsoOptions } from "./auth/oidc.js";
import { userRoutes } from "./routes/users.js";
import { deviceRoutes } from "./routes/devices.js";
import { healthRoutes } from "./routes/health.js";
import { bookRoutes } from "./routes/books.js";
import { progressRoutes } from "./routes/progress.js";
import { bookmarkRoutes } from "./routes/bookmarks.js";
import { shelfRoutes } from "./routes/shelves.js";
import { homeShelfRoutes } from "./routes/home-shelves.js";
import { readingTimeRoutes } from "./routes/reading-time.js";
import { defaultWebDir, staticRoutes } from "./static.js";
import { libraryRoutes } from "./library/routes.js";
import { integrationsPlugin, lazyBox, type IntegrationsOptions } from "./integrations/index.js";
import { loadOrCreateKey } from "./integrations/secrets.js";
import { adminLibraryRoutes } from "./routes/admin-library.js";
import { adminSettingsRoutes, resolveLookup } from "./routes/admin-settings.js";
import { familyRoutes } from "./routes/admin-family.js";
import { jobsPlugin } from "./jobs/index.js";
import { requestsPlugin, type RequestsOptions } from "./requests/index.js";
import { storytellerPlugin } from "./storyteller/index.js";
import { discoverPlugin, type DiscoverOptions } from "./discover/index.js";
import { ereaderPlugin, type EreaderOptions } from "./ereader/index.js";
import { aiPlugin, type AiOptions } from "./ai/index.js";
import { backupPlugin } from "./backup/index.js";
import { securityHeaders } from "./security/headers.js";
import { narrationPlugin, type NarrationOptions } from "./narration/index.js";
import { learningPlugin, type LearningOptions } from "./learning/index.js";
import { rewardsPlugin } from "./rewards/index.js";
import { importsPlugin, type ImportsOptions } from "./imports/index.js";
import { audioPlugin, type AudioOptions } from "./audio/index.js";
import { librarianPlugin, type LibrarianOptions } from "./librarian/index.js";
import { KepubConverter } from "./kobo/kepub.js";
import { join } from "node:path";
import { familyAppsPlugin, type FamilyAppsOptions } from "./family-apps/index.js";

/** Test seams for outside services. */
export interface AppDeps {
  integrations?: Pick<IntegrationsOptions, "secretKey" | "fetchImpl" | "makeMailer">;
  requests?: Pick<RequestsOptions, "fetchImpl" | "pollMs">;
  /** false: tests drive jobs with app.jobs.drain(). */
  jobsAutostart?: boolean;
  discover?: Pick<DiscoverOptions, "fetchImpl" | "now">;
  ereader?: Pick<EreaderOptions, "kepub">;
  ai?: Pick<AiOptions, "secretKey" | "fetchImpl" | "now">;
  narration?: Pick<NarrationOptions, "fetchImpl" | "cacheDir">;
  learning?: Pick<LearningOptions, "fetchImpl" | "now">;
  rewards?: { now?: () => number };
  imports?: Pick<ImportsOptions, "fetchImpl">;
  sso?: Pick<SsoOptions, "fetchImpl" | "now">;
  /** ABS calls go through integrations.fetchImpl too. */
  audio?: Pick<AudioOptions, "pullTimeoutMs">;
  librarian?: Pick<LibrarianOptions, "convert" | "tools" | "fetchImpl">;
  familyApps?: Pick<FamilyAppsOptions, "fetchImpl" | "reportEveryMs">;
}

export async function buildApp(config: Config, db: Db, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  const trustedProxies = parseTrustedProxies(config.TRUSTED_PROXIES);
  const sessions = new SessionSigner(loadSessionSecret(db, config.SESSION_SECRET));
  const sso = ssoConfigFrom(config);
  if (!sso && (config.SSO_ISSUER || config.SSO_CLIENT_ID || config.SSO_CLIENT_SECRET)) {
    app.log.warn("Single sign-on is off: set all of PUBLIC_URL, SSO_ISSUER, SSO_CLIENT_ID and SSO_CLIENT_SECRET");
  }

  await app.register(securityHeaders, { trustedProxies, csp: config.CONTENT_SECURITY_POLICY });
  await app.register(authPlugin, {
    db,
    emailHeader: config.AUTH_HEADER_EMAIL,
    trustedProxies,
    sessions,
    deviceIdleMs: config.DEVICE_IDLE_DAYS * 86_400_000,
  });
  await app.register(authRoutes, {
    db,
    sessions,
    trustedProxies,
    googleSignInUrl: config.GOOGLE_SIGN_IN_URL,
    emailHeader: config.AUTH_HEADER_EMAIL,
    sso: sso ? { label: sso.label, url: SSO_START_PATH } : undefined,
  });
  if (sso) await app.register(ssoRoutes, { db, sessions, trustedProxies, sso, ...deps.sso });
  await app.register(userRoutes, { db });
  await app.register(deviceRoutes, { db, trustedProxies });
  await app.register(healthRoutes);
  // Before any plugin that registers job handlers (library, requests).
  await app.register(jobsPlugin, { db, autostart: deps.jobsAutostart });
  // Before the book, reading-time and audio routes: its bedtime guard hook must exist first.
  await app.register(rewardsPlugin, { db, ...deps.rewards });
  await app.register(bookRoutes, { db });
  await app.register(progressRoutes, { db });
  await app.register(bookmarkRoutes, { db });
  await app.register(shelfRoutes, { db });
  // Same key file as the integrations' SecretBox (CONFIG_DIR/secret.key), created on first use.
  const box = lazyBox(() => deps.integrations?.secretKey ?? loadOrCreateKey(config.CONFIG_DIR));
  await app.register(libraryRoutes, { db, config, resolveLookup: () => resolveLookup(db, box, config) });
  await app.register(homeShelfRoutes, { db });
  await app.register(readingTimeRoutes, { db });
  // Before integrations: its audio guard hook must exist when the track routes are added.
  await app.register(storytellerPlugin, { db });
  await app.register(adminLibraryRoutes, { db });
  await app.register(adminSettingsRoutes, { db, box, config });
  await app.register(familyRoutes, { db });
  await app.register(integrationsPlugin, {
    db,
    configDir: config.CONFIG_DIR,
    booksDir: config.BOOKS_DIR,
    ...deps.integrations,
  });
  // After storyteller (its bedtime guard covers the audio track route) and integrations.
  await app.register(audioPlugin, {
    db,
    box,
    audiobooksDir: config.AUDIOBOOKS_DIR,
    configDir: config.CONFIG_DIR,
    scanOnStart: config.LIBRARY_SCAN_ON_START,
    lookup: () => resolveLookup(db, box, config),
    fetchImpl: deps.integrations?.fetchImpl,
    ...deps.audio,
  });
  await app.register(requestsPlugin, {
    db,
    box,
    booksDir: resolve(config.BOOKS_DIR),
    resolveLookup: () => resolveLookup(db, box, config, deps.requests?.fetchImpl ? { fetch: deps.requests.fetchImpl } : {}),
    ...deps.requests,
  });
  await app.register(discoverPlugin, {
    db,
    config,
    box,
    resolveLookup: () => resolveLookup(db, box, config),
    ...deps.discover,
  });
  // One KEPUB converter for the Kobo routes and the librarian's "ahead of time" job: one cache.
  const kepub = deps.ereader?.kepub ?? new KepubConverter(config.KEPUBIFY_PATH, join(config.CONFIG_DIR, "cache"), app.log);
  await app.register(ereaderPlugin, { db, config, trustedProxies, ...deps.ereader, kepub });
  await app.register(librarianPlugin, { db, config, resolveLookup: () => resolveLookup(db, box, config), kepub, ...deps.librarian });
  await app.register(aiPlugin, {
    db,
    configDir: config.CONFIG_DIR,
    booksDir: config.BOOKS_DIR,
    secretKey: deps.integrations?.secretKey,
    ...deps.ai,
  });
  // Read-aloud and learning (ws/readaloud).
  await app.register(narrationPlugin, { db, configDir: config.CONFIG_DIR, booksDir: config.BOOKS_DIR, secretKey: deps.integrations?.secretKey, ...deps.narration });
  await app.register(learningPlugin, {
    db,
    configDir: config.CONFIG_DIR,
    booksDir: config.BOOKS_DIR,
    secretKey: deps.integrations?.secretKey,
    fetchImpl: deps.learning?.fetchImpl ?? deps.ai?.fetchImpl,
    now: deps.learning?.now ?? deps.ai?.now,
  });
  await app.register(importsPlugin, { db, box, configDir: config.CONFIG_DIR, ...deps.imports });
  await app.register(familyAppsPlugin, { db, box, ...deps.familyApps });
  await app.register(backupPlugin, {
    db,
    configDir: config.CONFIG_DIR,
    backupDir: config.BACKUP_DIR,
    keep: config.BACKUP_KEEP,
    time: config.BACKUP_TIME,
  });
  // Last: the web app and its index.html fallback for client-side routes.
  await app.register(staticRoutes, { webDir: config.WEB_DIR ?? defaultWebDir() });

  return app;
}
