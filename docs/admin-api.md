# Admin and family API

What the `/admin` and `/family` web pages call (`apps/web/src/admin/api.ts`). All `/api/admin/*`
endpoints are admin-only (`requireAdmin`, CLAUDE.md rule 4). Moderation lists (inbox, review queue)
show books regardless of rating so an admin can rate them; everything a parent sees about a kid goes
through `visibleBooksWhere` for the parent (rule 1).

## Already in place (other workstreams)

| Method | Path | Source |
| --- | --- | --- |
| GET/POST | `/api/admin/library/scan` | `library/routes.ts` |
| GET | `/api/admin/inbox` | `library/routes.ts` (includes `possibleDuplicates`) |
| POST | `/api/admin/inbox/approve`, `/api/admin/inbox/:id/approve`, `/api/admin/inbox/:id/reject` | `library/routes.ts` |
| PUT | `/api/admin/books/:id/rating` | `library/routes.ts` |
| POST | `/api/admin/books/:id/metadata/refresh` | `library/routes.ts` (now reads the metadata settings below) |
| GET/POST/PATCH/PUT/DELETE | `/api/users…` | `routes/users.ts` |
| GET/POST/PATCH/DELETE | `/api/devices…` | `routes/devices.ts` |
| GET | `/api/reading/stats?userId=<kid>&days=7&utcOffset=` | `routes/reading-time.ts` (lead; minutes per day, streak, top books on the family pages) |
| GET/PUT/POST | `/api/admin/integrations/audiobookshelf[/test]`, `/api/admin/integrations/smtp[/test]` | `integrations/` |
| GET/PUT/POST/DELETE | `/api/admin/family-apps…` (Den Duty and Nighttime Ninja links, kid matching, report now) | `family-apps/` ([README](../apps/server/src/family-apps/README.md)) |

## Added by ws/admin

| Method | Path | File | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/overview` | `routes/admin-library.ts` | Counts: `inbox, unrated, books, people{grownUps,kids}, devices, pendingRequests` |
| GET | `/api/admin/review/unrated?limit&offset&scope=approved\|all` | `routes/admin-library.ts` | Approved books with no rating (Kindle-only entries left out) |
| GET | `/api/admin/books/:id` | `routes/admin-library.ts` | Any book, with authors, files, tags, series |
| PATCH | `/api/admin/books/:id` | `routes/admin-library.ts` | `title, sortTitle, originalTitle, subtitle, description, publisher, language, publishedYear, isbn13, pageCount, authors[], rating, series: { name, position } \| null, categories[]` (every genre, "Fiction"/"Nonfiction" included; replaces the list), `hardcoverId, openLibraryId, googleBooksId`; `""` or `null` clears a field. Every field sent is locked (`lockedFields`) unless `locks[]` is given, which replaces the lock set. Locked fields are left alone by metadata refresh, Calibre import and the auto-categorizer |
| GET | `/api/admin/category-names` | `routes/admin-library.ts` | `{ names }`: the curated categories plus any an admin made, for the book editor |
| POST | `/api/admin/books/:id/merge` | `routes/admin-library.ts` | `{ intoId }`. Moves files, tags, shelves, collections, bookmarks and progress (newest wins) to the target, fills its empty fields, deletes the source. File paths are unchanged, so a rescan keeps the merge |
| GET/PUT | `/api/admin/settings/metadata` | `routes/admin-settings.ts` | `{ online, hardcoverToken?, googleApiKey? }`; omit a key to keep it, `null` clears it. Keys sealed with the integrations SecretBox, never returned. Env vars apply until saved |
| GET | `/api/family/kids` | `routes/admin-family.ts` | Parent: every kid in their own family. Admin: every kid, plus `families[]` to group them. Each with `stats` and `familyId` |
| GET | `/api/family/kids/:id` | `routes/admin-family.ts` | `kid, stats, reading[], requests[], chats[]` |
| GET | `/api/family/kids/:id/chats/:conversationId` | `routes/admin-family.ts` | Read-only messages, system prompts left out |

Kids and plain adults get 403 from `/api/family/*`; a kid who isn't yours is 404.

## Families

Several families can share one server (for example yours and a brother's). Each family has its own
parents, grown-ups and kids; a **parent** looks after every kid in their own family (limits, sign-in,
shelves, requests, reading goals, Barnaby settings, tablets) and never sees another family. Only a
server **admin** creates families, moves people between them and changes anything server-wide.
People with no family (a new single sign-on account lands there) can read but manage nobody until
an admin places them.

| Method | Path | File | Notes |
| --- | --- | --- | --- |
| GET | `/api/families` | `routes/families.ts` | Admin: `families[]` (with `members`, counts) and `unassigned[]`. Others: their own family. Kids 403 |
| GET | `/api/families/:id` | `routes/families.ts` | Admin any, others only their own (404) |
| POST | `/api/families` | `routes/families.ts` | Admin: `{ name }` |
| PATCH | `/api/families/:id` | `routes/families.ts` | Rename `{ name }`: admin, or a parent of that family |
| DELETE | `/api/families/:id` | `routes/families.ts` | Admin; 409 until it's empty |
| PATCH | `/api/users/:id` `{ familyId }` | `routes/users.ts` | Admin moves someone (`null` = no family). Parent links that would cross families are dropped; refused if a kid would be left with no parent |
| POST | `/api/users` `{ familyId? }` | `routes/users.ts` | Admin picks the family (default: their own); a parent always adds to their own |
| POST | `/api/devices/pairings` `{ familyId? }` | `routes/devices.ts` | A family's tablet shows only that family on "Who's reading?"; admin may pick any family or `null` for everyone |

Migration `0017_families` puts everyone already on the server, and every paired tablet, into one
family named after the household, so nothing changes until a second family is added.

## Parent approved

Parents (and admins) approve books for one kid or for their whole family. Kids see both on their
home in a **Parent approved** row (`kind: "kid"` in `GET /api/shelves`, `?shelf=kid` on
`/api/books`, `/opds/kid`), and each kid only sees approved books within their own limit, so a
family pick never lifts anyone's limit.

| Method | Path | File | Notes |
| --- | --- | --- | --- |
| GET | `/api/books/:id/approvals` | `routes/families.ts` | Parent/admin: `{ family: { id, name, approved }, kids: [{ id, displayName, approved, canSee }] }` for their own family |
| GET | `/api/families/:id/approved` | `routes/families.ts` | Books approved for the whole family |
| PUT/DELETE | `/api/families/:id/approved/:bookId` | `routes/families.ts` | A parent of that family or an admin. PUT answers `{ ok, hiddenFrom: [kid names] }` for kids it's above |
| PUT/DELETE | `/api/shelves/kids/:kidId/books/:bookId` | `routes/shelves.ts` | One kid (unchanged); `GET /api/shelves/kids/:kidId` now also lists family picks with `familyPick: true` |
