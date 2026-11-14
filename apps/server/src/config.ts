import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
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
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
