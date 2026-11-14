/**
 * Integration settings, stored in the `settings` table. Secret fields are sealed
 * with the SecretBox and never returned to clients (only `hasToken`/`hasPassword`).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { SecretBox } from "./secrets.js";

export const ABS_KEY = "integrations.audiobookshelf";
export const SMTP_KEY = "integrations.smtp";

const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be http(s)")
  .transform((u) => u.replace(/\/+$/, ""));

export const AbsSettingsInput = z.object({
  enabled: z.boolean().default(true),
  url: httpUrl,
  /** Omit to keep the stored token. */
  token: z.string().min(1).optional(),
  /** Audiobookshelf library ids to use; empty = every book library. */
  libraryIds: z.array(z.string().min(1)).default([]),
});
export type AbsSettingsInput = z.infer<typeof AbsSettingsInput>;

export interface AbsSettings {
  enabled: boolean;
  url: string;
  token: string;
  libraryIds: string[];
}

export const SmtpSettingsInput = z.object({
  enabled: z.boolean().default(true),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(587),
  /** true = TLS from the start (port 465); false = STARTTLS when offered. */
  secure: z.boolean().default(false),
  user: z.string().optional(),
  /** Omit to keep the stored password. */
  password: z.string().optional(),
  /** Must be on each Kindle's "approved personal document e-mail" list. */
  from: z.string().email(),
});
export type SmtpSettingsInput = z.infer<typeof SmtpSettingsInput>;

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

interface Stored<T> {
  value: T;
}

function read<T>(db: Db, key: string): Stored<T> | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? { value: row.value as T } : null;
}

function write(db: Db, key: string, value: unknown): void {
  const now = Date.now();
  db.insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}

type AbsStored = Omit<AbsSettings, "token"> & { token: string };
type SmtpStored = Omit<SmtpSettings, "password"> & { password?: string };

export function getAbsSettings(db: Db, box: SecretBox): AbsSettings | null {
  const s = read<AbsStored>(db, ABS_KEY);
  if (!s) return null;
  return { ...s.value, token: box.open(s.value.token) };
}

export function saveAbsSettings(db: Db, box: SecretBox, input: AbsSettingsInput): AbsSettings {
  const current = getAbsSettings(db, box);
  const token = input.token ?? current?.token;
  if (!token) throw Object.assign(new Error("token is required"), { statusCode: 400 });
  const next: AbsSettings = { enabled: input.enabled, url: input.url, token, libraryIds: input.libraryIds };
  write(db, ABS_KEY, { ...next, token: box.seal(token) } satisfies AbsStored);
  return next;
}

export function publicAbsSettings(s: AbsSettings | null) {
  if (!s) return { configured: false as const };
  return { configured: true as const, enabled: s.enabled, url: s.url, libraryIds: s.libraryIds, hasToken: !!s.token };
}

export function getSmtpSettings(db: Db, box: SecretBox): SmtpSettings | null {
  const s = read<SmtpStored>(db, SMTP_KEY);
  if (!s) return null;
  return { ...s.value, password: s.value.password ? box.open(s.value.password) : undefined };
}

export function saveSmtpSettings(db: Db, box: SecretBox, input: SmtpSettingsInput): SmtpSettings {
  const current = getSmtpSettings(db, box);
  const password = input.password ?? current?.password;
  const next: SmtpSettings = {
    enabled: input.enabled,
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.user,
    password,
    from: input.from,
  };
  write(db, SMTP_KEY, { ...next, password: password ? box.seal(password) : undefined } satisfies SmtpStored);
  return next;
}

export function publicSmtpSettings(s: SmtpSettings | null) {
  if (!s) return { configured: false as const };
  const { password, ...rest } = s;
  return { configured: true as const, ...rest, hasPassword: !!password };
}
