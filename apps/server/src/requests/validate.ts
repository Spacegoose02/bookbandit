import type { z } from "zod";
import { httpError } from "../auth/plugin.js";

/** zod parse that answers 400 instead of a 500 on bad input. */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw httpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return r.data;
}
