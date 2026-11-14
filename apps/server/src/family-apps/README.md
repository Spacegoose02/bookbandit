# Family apps: Den Duty and Nighttime Ninja

BookBandit links to the family's other self-hosted apps the same way they link to each other: an
admin saves the other app's address, its home id and a home API token (sealed with the app's
SecretBox, never sent back to the browser). BookBandit always calls out; it accepts no tokens from them.
Settings live in the `settings` table under `family-apps:<householdId>`, so there's no migration.

## Den Duty (chores): reading earns practice points

- Admin → Connections → **Den Duty**: address, home id and a Den Duty **control** token
  (Den Duty → Settings → Home Assistant and API tokens). Then match each BookBandit kid to a
  Den Duty kid and one of their practice habits (e.g. "📚 Reading, 20 minutes").
- Every 5 minutes the server sends each matched kid's reading + listening minutes for yesterday
  and today (in the Den Duty home's time zone) and the books they finished that day to
  `POST /api/v1/homes/:homeId/reading/report`. Unchanged days aren't sent again. Den Duty logs
  the minutes into the habit (its usual needs-OK / trusted rules), pays the habit's points once a
  day, and can pay a "finished a book" bonus once per book.
- Only minutes and finished books leave BookBandit. Finished books go through the content lock for
  that kid (`visibleBooksWhere`), so a book the kid can't see is never named.
- Needs Den Duty with the reading report API (its `docs/bookbandit.md`).

## Nighttime Ninja (kitchen): Send to kitchen

- Admin → Connections → **Nighttime Ninja**: address, home id and a home token (`nnk_…`,
  Nighttime Ninja → Settings → Home → Home Assistant and automations). Optional: BookBandit's own
  address for the link back; otherwise the address the browser used.
- In Cook mode, grown-ups see a **Send to kitchen** strip for the recipe on screen. The web app reads
  that recipe out of the open EPUB (from its table-of-contents anchor to the next recipe's) as
  headings, paragraphs and list items; the server sorts them into notes, ingredients and steps
  (`kitchen.ts`), has Nighttime Ninja parse them (`POST …/recipes/import` with `{ text }`), and saves
  the result (`POST …/recipes`) with the cookbook's title as a tag, `sourceUrl` back to
  `/cook/:bookId?at=<href>`, and `noPublicShare: true` so it never goes on a public share link.
- Kids can't send recipes; a book the grown-up can't see is a 404.

## Endpoints

| Method | Path | Who | What |
| --- | --- | --- | --- |
| GET | `/api/admin/family-apps` | admin | Links (without tokens), this household's kids, last report |
| PUT / DELETE | `/api/admin/family-apps/den-duty` | admin | `{ url, homeId, token?, enabled, kids: [{ userId, kidId, habitId }] }` / unlink |
| GET | `/api/admin/family-apps/den-duty/kids` | admin | Den Duty's kids with their habits, for matching |
| POST | `/api/admin/family-apps/den-duty/report` | admin | Send the report now |
| PUT / DELETE | `/api/admin/family-apps/kitchen` | admin | `{ url, homeId, token? }` / unlink |
| POST | `/api/admin/family-apps/kitchen/check` | admin | Test the Nighttime Ninja link |
| PUT | `/api/admin/family-apps/public-url` | admin | `{ publicUrl }` (null clears) |
| GET | `/api/family-apps` | reader | `{ kitchen, denDuty }`: whether Send to kitchen shows (never for kids), and whether this kid's reading goes to a Den Duty habit |
| POST | `/api/family-apps/kitchen/recipes` | grown-up | `{ bookId, title, href?, blocks }` → `{ id, url, title, ingredients, steps }` |

A token left out of a PUT keeps the stored one; `null` clears it. Errors from the other app come
back as 502 with a plain message ("Den Duty didn't accept the token").

## Signing in once

BookBandit, Den Duty and Nighttime Ninja can all sit behind one Tinyauth: BookBandit trusts the
email header from `TRUSTED_PROXIES`, and Den Duty and Nighttime Ninja use `FORWARD_AUTH_HEADER`
(see their `docs/single-sign-on.md`). Kids keep their own profiles in each app.
