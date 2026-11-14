import type { Db } from "../db/client.js";
import type { SecretBox } from "./secrets.js";
import type { FetchLike } from "./audiobookshelf/client.js";
import type { MailSender } from "./kindle/mailer.js";
import type { SmtpSettings } from "./settings.js";

export interface IntegrationsContext {
  db: Db;
  box: SecretBox;
  booksDir: string;
  fetchImpl: FetchLike;
  /** Builds the SMTP sender; tests swap in a fake. */
  makeMailer: (s: SmtpSettings) => MailSender;
}

export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}
