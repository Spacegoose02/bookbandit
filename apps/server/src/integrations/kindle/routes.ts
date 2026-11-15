/**
 * Send to Kindle over SMTP (EPUB and PDF; Amazon converts EPUB itself).
 * No DRM handling of any kind: only plain files from /books are sent.
 *
 * Who can send: any signed-in reader, for books they can see (content lock).
 * Kindle addresses: adults set their own; a kid's address is set by their parent or an admin,
 * and only Amazon Kindle domains are accepted so this can't be used to email files anywhere.
 */
import type { FastifyInstance } from "fastify";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { canManageKids } from "@bookbandit/shared";
import { requireAdmin, requireReader } from "../../auth/plugin.js";
import { isFamilyParentOf } from "../../auth/permissions.js";
import type { Reader } from "../../auth/reader.js";
import { assertCanSee, ContentLockedError } from "../../content/lock.js";
import { bookFiles, books, users } from "../../db/schema.js";
import { kindleAddresses } from "../schema.js";
import { httpError, type IntegrationsContext } from "../context.js";
import { getSmtpSettings, publicSmtpSettings, saveSmtpSettings, SmtpSettingsInput } from "../settings.js";

export const KINDLE_DOMAINS = ["kindle.com", "free.kindle.com", "kindle.cn"] as const;
/** Amazon's limit for e-mailed documents. */
export const KINDLE_MAX_BYTES = 50 * 1024 * 1024;
const SENDABLE = ["epub", "pdf"] as const;
const CONTENT_TYPES: Record<(typeof SENDABLE)[number], string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
};
const SENDS_PER_HOUR = 20;

const KindleEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .refine((e) => KINDLE_DOMAINS.includes(e.split("@")[1] as (typeof KINDLE_DOMAINS)[number]), {
    message: `Must be a Kindle address (${KINDLE_DOMAINS.map((d) => "@" + d).join(", ")})`,
  });

const UserParams = z.object({ userId: z.string().min(1) });
const BookParams = z.object({ id: z.string().min(1) });
const AddressBody = z.object({ email: KindleEmail });
const SendBody = z.object({ format: z.enum(SENDABLE).optional() });
const TestBody = z.object({ to: z.string().email() });

export async function kindleRoutes(app: FastifyInstance, ctx: IntegrationsContext) {
  const { db, box } = ctx;
  const recentSends = new Map<string, number[]>();

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    return reply.send(err);
  });

  /** Can `actor` change `targetUserId`'s Kindle address? */
  function assertCanEdit(actor: Reader, targetUserId: string) {
    const target = db.select().from(users).where(eq(users.id, targetUserId)).get();
    if (!target || target.householdId !== actor.householdId) throw httpError(404, "Not found");
    if (actor.role === "admin") return;
    if (target.role === "kid") {
      if (!isFamilyParentOf(actor, target)) throw httpError(403, "Only a parent can change a kid's Kindle address");
      return;
    }
    if (actor.userId !== targetUserId) throw httpError(403, "You can only change your own Kindle address");
  }

  function addressFor(userId: string) {
    return db.select().from(kindleAddresses).where(eq(kindleAddresses.userId, userId)).get() ?? null;
  }

  // ---------------------------------------------------------------- addresses

  app.get("/api/kindle/me", async (req) => {
    const reader = requireReader(req);
    const smtp = getSmtpSettings(db, box);
    return {
      email: addressFor(reader.userId)?.email ?? null,
      canEdit: reader.role !== "kid",
      available: !!smtp?.enabled,
      fromAddress: smtp?.enabled ? smtp.from : null,
    };
  });

  app.get("/api/kindle/addresses/:userId", async (req) => {
    const reader = requireReader(req);
    const { userId } = UserParams.parse(req.params);
    if (userId !== reader.userId) assertCanEdit(reader, userId);
    return { userId, email: addressFor(userId)?.email ?? null };
  });

  app.put("/api/kindle/addresses/:userId", async (req) => {
    const reader = requireReader(req);
    const { userId } = UserParams.parse(req.params);
    const { email } = AddressBody.parse(req.body);
    assertCanEdit(reader, userId);
    const values = { userId, email, setBy: reader.userId, updatedAt: Date.now() };
    db.insert(kindleAddresses)
      .values(values)
      .onConflictDoUpdate({ target: kindleAddresses.userId, set: values })
      .run();
    return { userId, email };
  });

  app.delete("/api/kindle/addresses/:userId", async (req, reply) => {
    const reader = requireReader(req);
    const { userId } = UserParams.parse(req.params);
    assertCanEdit(reader, userId);
    db.delete(kindleAddresses).where(eq(kindleAddresses.userId, userId)).run();
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- send

  app.post("/api/books/:id/send-to-kindle", async (req) => {
    const reader = requireReader(req);
    const { id } = BookParams.parse(req.params);
    const { format } = SendBody.parse(req.body ?? {});

    const book = db.select().from(books).where(eq(books.id, id)).get();
    if (!book) throw new ContentLockedError();
    assertCanSee(reader, book);

    const smtp = getSmtpSettings(db, box);
    if (!smtp?.enabled) throw httpError(503, "Send to Kindle isn't set up yet. Ask an admin to add the email settings.");
    const address = addressFor(reader.userId);
    if (!address) throw httpError(409, "Add your Kindle email address first");

    const files = db
      .select()
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, id), inArray(bookFiles.format, format ? [format] : [...SENDABLE])))
      .all();
    // EPUB first: Kindle converts it to a reflowable book. PDF is the fallback.
    const file = files.sort((a, b) => SENDABLE.indexOf(a.format as never) - SENDABLE.indexOf(b.format as never))[0];
    if (!file) throw httpError(422, book.kindleOnly ? "This book is already on Kindle" : "No EPUB or PDF file for this book");

    const root = resolve(ctx.booksDir);
    const abs = resolve(root, file.relPath);
    if (!abs.startsWith(root + sep)) throw httpError(422, "Bad file path");
    const size = (await stat(abs).catch(() => null))?.size;
    if (size == null) throw httpError(422, "The book file is missing on disk");
    if (size > KINDLE_MAX_BYTES) throw httpError(413, "This file is over Amazon's 50 MB limit");

    const now = Date.now();
    const recent = (recentSends.get(reader.userId) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= SENDS_PER_HOUR) throw httpError(429, "Too many sends this hour, try again later");

    const ext = file.format as (typeof SENDABLE)[number];
    const filename = `${safeFilename(book.title)}.${ext}`;
    await ctx.makeMailer(smtp).send({
      to: address.email,
      subject: book.title,
      text: `${book.title}, sent from Bookbandit by ${reader.displayName}.`,
      attachments: [{ filename, path: abs, contentType: CONTENT_TYPES[ext] }],
    });
    recentSends.set(reader.userId, [...recent, now]);
    req.log.info({ bookId: id, userId: reader.userId, format: ext }, "sent to kindle");
    return { sentTo: address.email, filename, format: ext };
  });

  // ---------------------------------------------------------------- admin

  app.get("/api/admin/integrations/smtp", async (req) => {
    requireAdmin(req);
    return publicSmtpSettings(getSmtpSettings(db, box));
  });

  app.put("/api/admin/integrations/smtp", async (req) => {
    requireAdmin(req);
    const input = SmtpSettingsInput.parse(req.body);
    return publicSmtpSettings(saveSmtpSettings(db, box, input));
  });

  app.post("/api/admin/integrations/smtp/test", async (req) => {
    requireAdmin(req);
    const { to } = TestBody.parse(req.body);
    const smtp = getSmtpSettings(db, box);
    if (!smtp) throw httpError(409, "Save the SMTP settings first");
    const mailer = ctx.makeMailer(smtp);
    try {
      await mailer.verify();
      await mailer.send({ to, subject: "Bookbandit test email", text: "Send to Kindle email settings work." });
    } catch (e) {
      req.log.warn({ err: e }, "smtp test failed");
      throw httpError(502, `SMTP test failed: ${(e as Error).message}`);
    }
    return { ok: true };
  });
}

export function safeFilename(title: string): string {
  const cleaned = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s.,'()-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || "book";
}
