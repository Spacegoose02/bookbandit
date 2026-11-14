/**
 * Linked family apps: Den Duty (chores) and Nighttime Ninja (kitchen), per household.
 *
 * Stored in the `settings` table under `family-apps:<householdId>`, so no migration is needed.
 * Tokens are sealed with the app's SecretBox and never sent back to the browser (only `hasToken`).
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";
import type { SecretBox } from "../integrations/secrets.js";

export const settingsKey = (householdId: string) => `family-apps:${householdId}`;

export interface KidLink {
  /** Den Duty kid id. */
  kidId: string;
  /** Den Duty practice habit that BookBandit's minutes fill. */
  habitId: string;
}

export interface DenDutyLink {
  url: string;
  homeId: string;
  /** Sealed control token. */
  token: string;
  enabled: boolean;
  /** BookBandit kid user id → Den Duty kid and habit. */
  kids: Record<string, KidLink>;
}

export interface KitchenLink {
  url: string;
  homeId: string;
  /** Sealed home API token (`nnk_…`). */
  token: string;
}

export interface Stored {
  denDuty?: DenDutyLink;
  kitchen?: KitchenLink;
  /** BookBandit's own address, for links back from the other apps. Falls back to the request's. */
  publicUrl?: string;
}

/** An app's address: http(s) only, no trailing slash. */
const appUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), "Use an http:// or https:// address")
  .transform((u) => u.replace(/\/+$/, ""));
const homeId = z.string().trim().min(1).max(100);
/** A new token, null to unlink, or omitted to keep the stored one. */
const token = z.string().trim().min(1).max(500).nullable().optional();

export const DenDutyInput = z
  .object({
    url: appUrl,
    homeId,
    token,
    enabled: z.boolean().default(true),
    kids: z
      .array(z.object({ userId: z.string().min(1).max(64), kidId: z.string().min(1).max(100), habitId: z.string().min(1).max(100) }))
      .max(50)
      .default([]),
  })
  .strict();

export const KitchenInput = z.object({ url: appUrl, homeId, token }).strict();

export const PublicUrlInput = z.object({ publicUrl: appUrl.nullable() }).strict();

export function readStored(db: Db, householdId: string): Stored {
  const row = db.select().from(settings).where(eq(settings.key, settingsKey(householdId))).get();
  return (row?.value as Stored | undefined) ?? {};
}

export function writeStored(db: Db, householdId: string, value: Stored): void {
  const key = settingsKey(householdId);
  db.insert(settings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
    .run();
}

/** Every household that has a Den Duty link switched on. */
export function linkedHouseholds(db: Db): { householdId: string; link: DenDutyLink }[] {
  return db
    .select()
    .from(settings)
    .all()
    .filter((r) => r.key.startsWith("family-apps:"))
    .flatMap((r) => {
      const v = r.value as Stored;
      return v.denDuty?.enabled ? [{ householdId: r.key.slice("family-apps:".length), link: v.denDuty }] : [];
    });
}

/** Resolves a token update: new value sealed, null clears, undefined keeps. */
export function nextToken(box: SecretBox, input: string | null | undefined, stored: string | undefined): string | undefined {
  if (input === undefined) return stored;
  if (input === null) return undefined;
  return box.seal(input);
}

export function publicSettings(s: Stored) {
  return {
    publicUrl: s.publicUrl ?? null,
    denDuty: s.denDuty
      ? {
          url: s.denDuty.url,
          homeId: s.denDuty.homeId,
          hasToken: !!s.denDuty.token,
          enabled: s.denDuty.enabled,
          kids: Object.entries(s.denDuty.kids).map(([userId, k]) => ({ userId, ...k })),
        }
      : null,
    kitchen: s.kitchen ? { url: s.kitchen.url, homeId: s.kitchen.homeId, hasToken: !!s.kitchen.token } : null,
  };
}
