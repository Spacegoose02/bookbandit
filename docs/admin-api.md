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

## Added by ws/admin

| Method | Path | File | Notes |
| --- | --- | --- | --- |
| GET | `/api/admin/overview` | `routes/admin-library.ts` | Counts: `inbox, unrated, books, people{grownUps,kids}, devices, pendingRequests` |
| GET | `/api/admin/review/unrated?limit&offset&scope=approved\|all` | `routes/admin-library.ts` | Approved books with no rating (Kindle-only entries left out) |
| GET | `/api/admin/books/:id` | `routes/admin-library.ts` | Any book, with authors, files, tags, series |
| PATCH | `/api/admin/books/:id` | `routes/admin-library.ts` | `title, subtitle, description, publisher, language, publishedYear, isbn13, authors[], rating`; `""` or `null` clears a field |
| POST | `/api/admin/books/:id/merge` | `routes/admin-library.ts` | `{ intoId }`. Moves files, tags, shelves, collections, bookmarks and progress (newest wins) to the target, fills its empty fields, deletes the source. File paths are unchanged, so a rescan keeps the merge |
| GET/PUT | `/api/admin/settings/metadata` | `routes/admin-settings.ts` | `{ online, hardcoverToken?, googleApiKey? }`; omit a key to keep it, `null` clears it. Keys sealed with the integrations SecretBox, never returned. Env vars apply until saved |
| GET | `/api/family/kids` | `routes/admin-family.ts` | Parent: linked kids. Admin: every kid. Each with `stats` |
| GET | `/api/family/kids/:id` | `routes/admin-family.ts` | `kid, stats, reading[], requests[], chats[]` |
| GET | `/api/family/kids/:id/chats/:conversationId` | `routes/admin-family.ts` | Read-only messages, system prompts left out |

Kids and plain adults get 403 from `/api/family/*`; a kid who isn't yours is 404.
