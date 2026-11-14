/**
 * Calibre-Web `app.db` import: each person's read status, shelves (as collections) and Kobo
 * reading positions. Calibre-Web only knows Calibre's book ids, so books are found through the
 * Calibre library (its metadata.db, or the links an earlier Calibre import saved).
 *
 * The admin maps each Calibre-Web user to a Bookbandit person; unmapped users are skipped.
 */
import type { Db } from "../db/client.js";
import { books } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { openForeignDb } from "./calibre.js";
import {
  addToCollection,
  ensureCollection,
  importProgress,
  person,
  upsertHistory,
  writeOrRollBack,
  parseDate,
  type Reporter,
  type SourcePerson,
} from "./common.js";

export interface CwUser {
  id: number;
  name: string;
  email: string | null;
}

export interface CwData {
  users: CwUser[];
  read: { userId: number; bookId: number; status: number; modified: number | null; started: number | null; times: number }[];
  shelves: { id: number; name: string; userId: number; isPublic: boolean; books: { bookId: number; order: number }[] }[];
  kobo: { userId: number; bookId: number; percent: number; modified: number | null }[];
}

/** Calibre-Web's read_status values. */
const STATUS_FINISHED = 1;
const STATUS_IN_PROGRESS = 2;

export function readCalibreWeb(path: string): CwData {
  const db = openForeignDb(path, ["user", "book_read_link"], "Calibre-Web app.db");
  try {
    const has = (t: string) => !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t);
    const users = (db.prepare("select id, name, email from user order by id").all() as CwUser[]).filter(
      (u) => u.name && u.name.toLowerCase() !== "guest",
    );
    const read = (
      db
        .prepare(
          "select user_id as userId, book_id as bookId, read_status as status, last_modified as modified, last_time_started_reading as started, times_started_reading as times from book_read_link",
        )
        .all() as { userId: number; bookId: number; status: number; modified: string | null; started: string | null; times: number | null }[]
    ).map((r) => ({ ...r, modified: parseDate(r.modified), started: parseDate(r.started), times: r.times ?? 0 }));

    const shelves: CwData["shelves"] = [];
    if (has("shelf") && has("book_shelf_link")) {
      const links = db.prepare('select shelf, book_id as bookId, "order" as ord from book_shelf_link order by shelf, "order", id').all() as {
        shelf: number;
        bookId: number;
        ord: number | null;
      }[];
      for (const s of db.prepare("select id, name, user_id as userId, is_public as isPublic from shelf").all() as {
        id: number;
        name: string;
        userId: number;
        isPublic: number;
      }[]) {
        shelves.push({
          id: s.id,
          name: s.name,
          userId: s.userId,
          isPublic: !!s.isPublic,
          books: links.filter((l) => l.shelf === s.id).map((l) => ({ bookId: l.bookId, order: l.ord ?? 0 })),
        });
      }
    }

    const kobo: CwData["kobo"] = [];
    if (has("kobo_reading_state") && has("kobo_bookmark")) {
      for (const k of db
        .prepare(
          `select s.user_id as userId, s.book_id as bookId, b.progress_percent as percent, b.last_modified as modified
           from kobo_reading_state s join kobo_bookmark b on b.kobo_reading_state_id = s.id
           where b.progress_percent is not null`,
        )
        .all() as { userId: number; bookId: number; percent: number; modified: string | null }[]) {
        kobo.push({ ...k, modified: parseDate(k.modified) });
      }
    }
    return { users, read, shelves, kobo };
  } finally {
    db.close();
  }
}

export interface CwOptions {
  /** Calibre-Web user id → Bookbandit user id (null or missing = skip that user). */
  people: Record<string, string | null>;
  shelves: boolean;
}

export async function importCalibreWeb(
  db: Db,
  data: CwData,
  bookIds: Map<number, string>,
  people: SourcePerson[],
  opts: CwOptions & { dryRun: boolean },
  report: Reporter,
): Promise<void> {
  report.report.people = people;
  const mapped = new Map(people.filter((p) => p.userId).map((p) => [Number(p.id), p.userId!]));
  const nameOf = new Map(data.users.map((u) => [u.id, u.name]));
  const titleOf = (tx: Pick<Db, "select">, id: string) => tx.select({ t: books.title }).from(books).where(eq(books.id, id)).get()?.t ?? "?";
  const unknownBooks = new Set<number>();

  await writeOrRollBack(db, opts.dryRun, (tx) => {
    for (const u of data.users) {
      if (!mapped.has(u.id)) report.add("skipped", `Calibre-Web user ${u.name}`, "Not matched to anyone in Bookbandit.");
    }

    // Read status (and the Kobo position, when there is one).
    const koboByKey = new Map(data.kobo.map((k) => [`${k.userId}:${k.bookId}`, k]));
    const done = new Set<string>();
    for (const r of data.read) {
      const userId = mapped.get(r.userId);
      if (!userId) continue;
      if (r.status !== STATUS_FINISHED && r.status !== STATUS_IN_PROGRESS) continue;
      const bookId = bookIds.get(r.bookId);
      const who = nameOf.get(r.userId) ?? "?";
      if (!bookId) {
        unknownBooks.add(r.bookId);
        report.add("skipped", `${who}: Calibre book #${r.bookId}`, "Not found in Bookbandit (import the Calibre library first, or scan).");
        continue;
      }
      const title = titleOf(tx, bookId);
      const finished = r.status === STATUS_FINISHED;
      const kobo = koboByKey.get(`${r.userId}:${r.bookId}`);
      done.add(`${r.userId}:${r.bookId}`);
      const at = Math.max(r.modified ?? 0, kobo?.modified ?? 0) || Date.now();
      const percent = finished ? 1 : kobo ? kobo.percent / 100 : 0;
      const hist = upsertHistory(tx, {
        userId,
        bookId,
        title,
        status: finished ? "read" : "reading",
        startedAt: r.started,
        finishedAt: finished ? r.modified : null,
        readCount: finished ? Math.max(1, r.times) : r.times,
        source: "calibre-web",
        sourceKey: String(r.bookId),
      });
      const prog = finished || kobo ? importProgress(tx, userId, bookId, { percent, finished, at, deviceName: "Calibre-Web" }) : "unchanged";
      const label = `${who}: ${title}`;
      if (prog === "kept-newer") report.add("conflict", label, "Bookbandit has a newer position; kept it.");
      else if (hist === "new" || prog === "written") report.add(hist === "new" ? "new" : "matched", label, finished ? "Finished" : kobo ? `Reading, ${Math.round(percent * 100)}%` : "Reading");
      else report.add("skipped", label, "Already up to date.");
    }

    // Kobo positions for books Calibre-Web didn't mark as reading.
    for (const k of data.kobo) {
      const userId = mapped.get(k.userId);
      if (!userId || done.has(`${k.userId}:${k.bookId}`) || k.percent <= 0) continue;
      const bookId = bookIds.get(k.bookId);
      if (!bookId) {
        unknownBooks.add(k.bookId);
        continue;
      }
      const label = `${nameOf.get(k.userId) ?? "?"}: ${titleOf(tx, bookId)}`;
      const prog = importProgress(tx, userId, bookId, {
        percent: k.percent / 100,
        finished: k.percent >= 99,
        at: k.modified ?? Date.now(),
        deviceName: "Kobo (Calibre-Web)",
      });
      if (prog === "kept-newer") report.add("conflict", label, "Bookbandit has a newer position; kept it.");
      else if (prog === "written") report.add("matched", label, `Kobo position ${Math.round(k.percent)}%`);
    }

    // Shelves → collections. A public shelf becomes a household collection.
    if (opts.shelves) {
      for (const s of data.shelves) {
        const userId = mapped.get(s.userId);
        if (!userId) continue;
        const owner = person(tx, userId);
        if (!owner) continue;
        const collectionId = ensureCollection(tx, owner.householdId, s.isPublic ? null : userId, s.name, report);
        let added = 0;
        let missing = 0;
        for (const b of s.books) {
          const bookId = bookIds.get(b.bookId);
          if (!bookId) {
            missing++;
            continue;
          }
          if (addToCollection(tx, collectionId, bookId)) added++;
        }
        report.stat("books put in collections", added);
        report.add(
          added ? "new" : "skipped",
          `Shelf "${s.name}" (${nameOf.get(s.userId) ?? "?"}${s.isPublic ? ", shared" : ""})`,
          `${added} books added${missing ? `, ${missing} not in Bookbandit` : ""}`,
        );
      }
    }
  });
  if (unknownBooks.size) report.warn(`${unknownBooks.size} Calibre books weren't found in Bookbandit; run the Calibre import (or a library scan) first.`);
}
