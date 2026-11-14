# Rewards: reading goals, badges, stickers and reading bedtime

Owned by `ws/kids`. Tables live in `schema.ts` (migration `0012_kids`).

## Rules

- **The server decides.** Goals and badges are computed from capped reading-time heartbeats
  (`reading_sessions`) and finished-book progress (`reading_progress.finished`), never from a
  client's claim. `evaluate()` runs whenever a summary is read and is idempotent: the unique
  `(user_id, award, key)` index means each badge or sticker is awarded once.
- **Kids can't change their own limits** (CLAUDE.md rule 2). Goals and bedtime are set only by a
  linked parent or an admin. A kid can only mark their own celebrations as seen.
- **Content lock.** A "finished a book" sticker names the book only when both the kid and the
  viewer may see it; otherwise it is a plain sticker with `book: null`.
- **Bedtime is enforced in `index.ts`** by a root-level `preHandler` hook, registered in `app.ts`
  before the book, reading-time and audio routes. At bedtime a kid gets
  `403 { bedtime: true, endsAt }` from:
  - `GET /api/books/:id/files/:fileId` (web reader and tablet downloads)
  - `POST /api/reading/heartbeat`
  - `GET /api/books/:id/audio/tracks/:index`, except for storyteller profiles, whose bedtime
    stories keep storyteller's own nightly limits.

  Not covered: books a tablet already downloaded for offline reading, and e-readers (OPDS, Kobo,
  KOReader), which download books ahead of time.

## Badges and stickers

Badges are listed in `packages/shared/src/rewards.ts` (`BADGES`): first book, 5/10/25 books,
3/7/30-day streaks, 1 and 10 hours, first goal day, 7 goal days in a row, monthly book goal.
Stickers repeat: one per finished book, per day the minutes goal was reached, and per month the
books goal was reached. A daily goal counts from the day it was set or changed, so lowering a
goal never backfills stickers.

Days are counted in the time zone saved with the goal (the parent's browser zone), else the
bedtime's, else UTC.

## API

| Method | Path | Who | What |
| --- | --- | --- | --- |
| GET | `/api/rewards/:userId` | self (`me`), linked parent, admin | `RewardsSummary`: today vs goal, month vs goal, streak, badges, stickers, `fresh` (unseen, self only), bedtime status |
| POST | `/api/rewards/me/seen` | self | `{ ids }` marks celebrations as seen |
| GET | `/api/rewards/me/bedtime` | self | `BedtimeStatus` (polled by the kid app every minute) |
| GET | `/api/rewards/kids/:kidId/settings` | kid (`me`), linked parent, admin | goal, bedtime, `canEdit` |
| PUT | `/api/rewards/kids/:kidId/goal` | linked parent, admin | `{ minutesPerDay (5-240) \| null, booksPerMonth (1-60) \| null, timeZone }` |
| PUT | `/api/rewards/kids/:kidId/bedtime` | linked parent, admin | `{ enabled, startMinute (12:00-23:59), endMinute (00:00-12:00), weekendStartMinute \| null, timeZone }` (minutes after midnight) |

Users the viewer may not see are 404. Weekend bedtime applies on Friday and Saturday nights.
