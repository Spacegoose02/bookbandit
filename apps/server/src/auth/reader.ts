import type { ReaderAccess, Role } from "@bookbandit/shared";

/** The signed-in person a request acts as. Attached to every authenticated request. */
export interface Reader extends ReaderAccess {
  userId: string;
  householdId: string;
  role: Role;
  displayName: string;
}

declare module "fastify" {
  interface FastifyRequest {
    reader: Reader | null;
  }
}
