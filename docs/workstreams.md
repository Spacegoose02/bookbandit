# Workstreams

Parallel work is split by area so branches rarely touch the same files. The lead keeps
`main`, the schema core (`apps/server/src/db/schema.ts`), `packages/shared` and `apps/server/src/app.ts`
consistent; other workstreams may make small additive edits there and call them out in the PR.

| # | Workstream | Branch prefix | Owns |
| --- | --- | --- | --- |
| 1 | Library ingest and metadata | `ws/library` | `apps/server/src/library/**`, `apps/server/src/metadata/**` |
| 2 | Family accounts and auth | `ws/auth` | `apps/server/src/auth/**`, `apps/server/src/routes/users.ts`, `routes/devices.ts` |
| 3 | Reading sync API | `ws/sync` | `apps/server/src/routes/progress.ts`, `routes/bookmarks.ts`, `routes/shelves.ts` |
| 4 | Web app and reader | `ws/web` | `apps/web/**` |
| 5 | Docker, Unraid and CI | `ws/docker` | `Dockerfile`, `docker/**`, `.github/**`, static serving in the server |
| 6 | Audiobookshelf and Send to Kindle | `ws/integrations` | `apps/server/src/integrations/**` |

Later phases (Android app, Shelfmark/downloaders, AI, Kobo/KOReader/OPDS) start after these land.
