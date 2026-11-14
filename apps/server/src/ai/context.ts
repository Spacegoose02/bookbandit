import type { Db } from "../db/client.js";
import type { SecretBox } from "../integrations/secrets.js";
import type { FetchLike } from "./providers/types.js";

/** Everything the AI routes share. `now` is a seam for tests (daily limits, ages). */
export interface AiContext {
  db: Db;
  box: SecretBox;
  fetchImpl: FetchLike;
  booksDir: string;
  now: () => Date;
}
