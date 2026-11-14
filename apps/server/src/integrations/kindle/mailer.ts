import nodemailer from "nodemailer";
import type { SmtpSettings } from "../settings.js";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; path: string; contentType: string }[];
}

export interface MailSender {
  send(mail: OutgoingMail): Promise<void>;
  verify(): Promise<void>;
}

export function smtpMailer(s: SmtpSettings): MailSender {
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.password ?? "" } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
  return {
    async send(mail) {
      await transport.sendMail({ from: s.from, ...mail });
    },
    async verify() {
      await transport.verify();
    },
  };
}
