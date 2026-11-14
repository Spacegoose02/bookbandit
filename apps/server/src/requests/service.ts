/**
 * Book requests: who may approve what, the rating guess, and how a request's status follows
 * its download job.
 *
 *   kid asks ──▶ pending ──(linked parent or admin approves)──▶ approved ──▶ downloading ──▶ done
 *     │                 └──(declined)──▶ declined                                  └──▶ failed
 *     └─ rating known and above the kid's limit ──▶ declined at once
 *
 * Adults' and parents' requests are approved by an admin; an admin's own requests are approved
 * at once. Approval starts a download when a downloader is set up and auto-download is on.
 */
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { maxAllowedRating, canSee, RATING_LABELS, type ContentRating } from "@bookbandit/shared";
import type { Db } from "../db/client.js";
import { bookRequests, books, jobs, parentLinks, users } from "../db/schema.js";
import type { Reader } from "../auth/reader.js";
import { assertCanSee, ContentLockedError } from "../content/lock.js";
import { sortTitle } from "../metadata/text.js";

export type RequestRow = typeof bookRequests.$inferSelect;
export type RequestStatus = RequestRow["status"];

/** Requests a person may have open (pending or approved) at once. */
export const MAX_OPEN_REQUESTS = 20;

export function isLinkedParent(db: Db, parentId: string, kidId: string): boolean {
  return !!db
    .select({ k: parentLinks.kidId })
    .from(parentLinks)
    .where(and(eq(parentLinks.parentId, parentId), eq(parentLinks.kidId, kidId)))
    .get();
}

interface Requester {
  id: string;
  role: string;
  householdId: string;
  displayName: string;
}

export function requesterOf(db: Db, r: RequestRow): Requester | undefined {
  return db
    .select({ id: users.id, role: users.role, householdId: users.householdId, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, r.requestedBy))
    .get();
}

/** Admin: anyone's in the household. Parent: their linked kids'. */
export function canApprove(db: Db, actor: Reader, requester: Requester): boolean {
  if (requester.householdId !== actor.householdId) return false;
  if (actor.role === "admin") return true;
  if (actor.role === "parent" && requester.role === "kid") return isLinkedParent(db, actor.userId, requester.id);
  return false;
}

/** The request if the actor may see it (their own, or one they can approve); otherwise 404. */
export function loadVisibleRequest(db: Db, actor: Reader, id: string): { row: RequestRow; requester: Requester } {
  const row = db.select().from(bookRequests).where(eq(bookRequests.id, id)).get();
  const requester = row && requesterOf(db, row);
  if (!row || !requester || requester.householdId !== actor.householdId) throw notFound();
  if (row.requestedBy !== actor.userId && !canApprove(db, actor, requester)) throw notFound();
  return { row, requester };
}

function notFound() {
  return new ContentLockedError();
}

/** Where a new request starts, given who asked and what we know about its rating. */
export function initialStatus(
  requester: Pick<Reader, "role" | "birthYear" | "isKid" | "explicitOptIn">,
  rating: ContentRating | null,
  today = new Date(),
): { status: "pending" | "approved" | "declined"; note: string | null } {
  if (requester.isKid && rating && !canSee(requester, rating, today)) {
    const max = maxAllowedRating(requester, today);
    return {
      status: "declined",
      note: `This book is rated ${RATING_LABELS[rating]}, above ${RATING_LABELS[max]}.`,
    };
  }
  if (requester.role === "admin") return { status: "approved", note: null };
  return { status: "pending", note: null };
}

/** Requests the actor can approve: SQL over book_requests joined to users. */
export function approvableWhere(db: Db, actor: Reader): SQL | undefined {
  if (actor.role === "admin") return eq(users.householdId, actor.householdId);
  if (actor.role === "parent") {
    const kids = db.select({ id: parentLinks.kidId }).from(parentLinks).where(eq(parentLinks.parentId, actor.userId)).all().map((k) => k.id);
    return kids.length ? and(eq(users.householdId, actor.householdId), inArray(bookRequests.requestedBy, kids)) : sql`0`;
  }
  return sql`0`;
}

export function openRequestCount(db: Db, userId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(bookRequests)
      .where(and(eq(bookRequests.requestedBy, userId), inArray(bookRequests.status, ["pending", "approved", "downloading"])))
      .get()?.n ?? 0
  );
}

/** An open or finished request for the same book by the same person, to avoid duplicates. */
export function findDuplicate(db: Db, userId: string, title: string, isbn13: string | null): RequestRow | undefined {
  const same: SQL[] = [sql`lower(${bookRequests.title}) = ${title.toLowerCase()}`];
  if (isbn13) same.push(eq(bookRequests.isbn13, isbn13));
  return db
    .select()
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.requestedBy, userId),
        inArray(bookRequests.status, ["pending", "approved", "downloading", "done"]),
        or(...same),
      ),
    )
    .orderBy(desc(bookRequests.createdAt))
    .get();
}

/** A library book the reader can already open that matches (ISBN, or exact title). */
export function findVisibleBook(db: Db, reader: Reader, title: string, isbn13: string | null, where: SQL | undefined) {
  const match: SQL[] = [eq(books.sortTitle, sortTitle(title))];
  if (isbn13) match.push(eq(books.isbn13, isbn13));
  return db
    .select({ id: books.id, title: books.title })
    .from(books)
    .where(and(where, or(...match), eq(books.kindleOnly, false)))
    .get();
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function requestViews(db: Db, viewer: Reader, rows: RequestRow[]) {
  if (!rows.length) return [];
  const userIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy].filter((x): x is string => !!x)))];
  const people = new Map(
    db
      .select({ id: users.id, displayName: users.displayName, role: users.role, householdId: users.householdId, avatar: users.avatar })
      .from(users)
      .where(inArray(users.id, userIds))
      .all()
      .map((u) => [u.id, u]),
  );
  const bookIds = rows.map((r) => r.bookId).filter((x): x is string => !!x);
  const bookRows = new Map(
    bookIds.length
      ? db
          .select({ id: books.id, title: books.title, rating: books.rating, approved: books.approved, coverPath: books.coverPath })
          .from(books)
          .where(inArray(books.id, bookIds))
          .all()
          .map((b) => [b.id, b])
      : [],
  );
  const jobIds = rows.map((r) => r.jobId).filter((x): x is string => !!x);
  const jobRows = new Map(
    jobIds.length
      ? db
          .select({ id: jobs.id, status: jobs.status, progress: jobs.progress, lastError: jobs.lastError })
          .from(jobs)
          .where(inArray(jobs.id, jobIds))
          .all()
          .map((j) => [j.id, j])
      : [],
  );

  return rows.map((r) => {
    const requester = people.get(r.requestedBy);
    const decider = r.decidedBy ? people.get(r.decidedBy) : undefined;
    // The finished book is shown only when this viewer may open it (content lock + inbox).
    let book: { id: string; title: string; coverPath: string | null } | null = null;
    let inInbox = false;
    const b = r.bookId ? bookRows.get(r.bookId) : undefined;
    if (b) {
      try {
        assertCanSee(viewer, b);
        book = { id: b.id, title: b.title, coverPath: b.coverPath };
      } catch {
        inInbox = !b.approved;
      }
    }
    const job = r.jobId ? jobRows.get(r.jobId) : undefined;
    const approver = requester ? canApprove(db, viewer, requester) : false;
    return {
      id: r.id,
      title: r.title,
      author: r.author,
      isbn13: r.isbn13,
      coverUrl: r.coverUrl,
      publishedYear: r.publishedYear,
      rating: r.rating,
      ratingReason: r.ratingReason,
      status: r.status,
      note: r.note,
      requestedBy: requester ? { id: requester.id, displayName: requester.displayName, role: requester.role, avatar: requester.avatar } : null,
      decidedBy: decider ? { id: decider.id, displayName: decider.displayName } : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      decidedAt: r.decidedAt,
      book,
      /** The download arrived and waits for an admin to approve it in the inbox. */
      waitingForReview: inInbox || (r.status === "done" && !book && !!r.bookId),
      download: job && (viewer.role === "admin" || approver || r.requestedBy === viewer.userId)
        ? { jobId: viewer.role === "admin" ? job.id : null, status: job.status, progress: job.progress, error: viewer.role === "admin" ? job.lastError : null }
        : null,
      canApprove: approver && (r.status === "pending" || r.status === "declined"),
      canDecline: approver && (r.status === "pending" || r.status === "approved"),
      canCancel: r.requestedBy === viewer.userId && r.status === "pending",
      canDownload: viewer.role === "admin" && (r.status === "approved" || r.status === "failed"),
    };
  });
}

export type RequestView = ReturnType<typeof requestViews>[number];

// ---------------------------------------------------------------------------
// Status changes driven by the download job
// ---------------------------------------------------------------------------

export function setRequest(db: Db, id: string, set: Partial<typeof bookRequests.$inferInsert>): void {
  db.update(bookRequests)
    .set({ ...set, updatedAt: Date.now() })
    .where(eq(bookRequests.id, id))
    .run();
}

export function requestDownloadHooks(db: Db) {
  return {
    onStarted: (requestId: string, jobId: string) => {
      db.update(bookRequests)
        .set({ status: "downloading", jobId, updatedAt: Date.now() })
        .where(and(eq(bookRequests.id, requestId), inArray(bookRequests.status, ["approved", "failed", "downloading"])))
        .run();
    },
    onImported: (requestId: string, result: { bookIds: string[]; files: string[] }) => {
      if (result.bookIds.length) {
        setRequest(db, requestId, { status: "done", bookId: result.bookIds[0]!, note: null });
      } else {
        setRequest(db, requestId, {
          status: "failed",
          note: result.files.length ? "The download arrived but couldn't be added to the library." : "Nothing was downloaded.",
        });
      }
    },
    onFailed: (requestId: string, error: string) => {
      db.update(bookRequests)
        .set({ status: "failed", note: error.slice(0, 500), updatedAt: Date.now() })
        .where(and(eq(bookRequests.id, requestId), isNull(bookRequests.bookId)))
        .run();
    },
  };
}
