import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  /** Audiobook folders, one per book (Docker volume /audiobooks). Scanned like BOOKS_DIR. */
  AUDIOBOOKS_DIR: z.string().default("./data/audiobooks"),
  /** Where the SQLite database, covers and caches live (Docker volume /config). */
  CONFIG_DIR: z.string().default("./data/config"),
  /** The library root (Docker volume /books). */
  BOOKS_DIR: z.string().default("./data/books"),
  /**
   * Header Tinyauth (via the reverse proxy) sets with the signed-in email.
   * Only trusted when the request comes from TRUSTED_PROXIES.
   */
  AUTH_HEADER_EMAIL: z.string().default("remote-email"),
  /** Comma-separated IPs/CIDRs of the reverse proxy. Empty = never trust auth headers. */
  TRUSTED_PROXIES: z.string().default(""),
  /**
   * Key that signs sign-in sessions (password, kid PIN/pictures). Optional: when empty, one is
   * generated on first start and kept in the database. Changing it signs everyone out.
   */
  /**
   * Where the "Sign in with Google" button goes: your Tinyauth login page (for example
   * https://auth.example.com/login?redirect_uri=https://books.example.com). Empty hides the button.
   */
  GOOGLE_SIGN_IN_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  SESSION_SECRET: z.string().min(32).optional(),
  /**
   * Single sign-on (OpenID Connect, e.g. Tinyauth). All four of PUBLIC_URL, SSO_ISSUER,
   * SSO_CLIENT_ID and SSO_CLIENT_SECRET turn it on; the provider's redirect URI is
   * PUBLIC_URL + /auth/sso/callback. SSO_LABEL is the button text ("Sign in with <label>").
   * New emails get an "adult" account unless SSO_AUTO_CREATE=false.
   */
  PUBLIC_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  SSO_ISSUER: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  SSO_CLIENT_ID: z.string().optional(),
  SSO_CLIENT_SECRET: z.string().optional(),
  SSO_LABEL: z.string().optional(),
  /** Make a new "adult" account for an SSO email nobody uses yet (default). "false" refuses it instead. */
  SSO_AUTO_CREATE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Built web app to serve (index.html + assets). Defaults to apps/web/dist next to the server. */
  WEB_DIR: z.string().optional(),
  /** Calibre's converter (installed in the Docker image) and kepubify, for format conversion. */
  EBOOK_CONVERT_PATH: z.string().default("ebook-convert"),
  KEPUBIFY_PATH: z.string().default("kepubify"),
  /** Library workstream: look up new books on Hardcover / Google Books / Open Library. */
  METADATA_ONLINE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Scan BOOKS_DIR when the server starts listening (skipped if the folder is missing or empty). */
  LIBRARY_SCAN_ON_START: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Optional: raises Google Books' anonymous quota. */
  GOOGLE_BOOKS_API_KEY: z.string().optional(),
  /** Optional: enables Hardcover lookups (hardcover.app → Account → API). */
  HARDCOVER_API_TOKEN: z.string().optional(),
  /** Optional: enables ISBNdb lookups (paid key from isbndb.com). */
  ISBNDB_API_KEY: z.string().optional(),
  /** Paired devices not seen for this many days must be paired again (0 = never expire). */
  DEVICE_IDLE_DAYS: z.coerce.number().min(0).default(180),
  /** Replaces the web app's Content-Security-Policy; "off" sends none. */
  CONTENT_SECURITY_POLICY: z.string().optional(),
  /** Where nightly database backups go. Default CONFIG_DIR/backups. */
  BACKUP_DIR: z.string().optional(),
  /** How many backups to keep (0 keeps all). */
  BACKUP_KEEP: z.coerce.number().int().min(0).default(7),
  /** Nightly backup time, "HH:MM" in the container's time zone (TZ), or "off". */
  BACKUP_TIME: z.string().default("03:00"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
