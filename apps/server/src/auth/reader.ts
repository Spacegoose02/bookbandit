import type { ReaderAccess, Role } from "@bookbandit/shared";
import type { users } from "../db/schema.js";

/** The signed-in person a request acts as. Attached to every authenticated request. */
export interface Reader extends ReaderAccess {
  userId: string;
  householdId: string;
  /** Their family inside the household; null until an admin places them in one. */
  familyId: string | null;
  role: Role;
  displayName: string;
}

/** A paired tablet or API client, when the request came with its device token or a session bound to it. */
export interface DeviceContext {
  id: string;
  householdId: string;
  /** The family whose tablet this is; null means the whole household (older pairings). */
  familyId: string | null;
  /** Set when the device is locked to one person (e.g. a kid's own tablet). */
  userId: string | null;
  name: string;
}

/** How the current reader was identified. */
export type AuthVia = "proxy" | "session" | "device";

declare module "fastify" {
  interface FastifyRequest {
    reader: Reader | null;
    device: DeviceContext | null;
    authVia: AuthVia | null;
  }
}

export function toReader(u: typeof users.$inferSelect): Reader {
  return {
    userId: u.id,
    householdId: u.householdId,
    familyId: u.familyId,
    role: u.role,
    displayName: u.displayName,
    birthYear: u.birthYear,
    isKid: u.role === "kid",
    explicitOptIn: u.role === "kid" ? false : u.explicitOptIn,
  };
}
