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

## Every PR

- **Screenshots.** Any PR that changes something a person can see (web app, reader, Android app,
  admin screens, Docker first-run page) adds screenshots to `docs/screenshots/`
  (`YYYY-MM-DD-<area>-<what>.png`) and embeds them in the PR description. Capture with Playwright at
  a desktop width and a tablet width (for example 1280×800 and 800×1280).
- **Roadmap.** Tick the matching item in [ROADMAP.md](ROADMAP.md) when it's done.
- **Handoff.** Add a row to "Recent changes" in [HANDOFF.md](HANDOFF.md), and update "How to run"
  or "Next up" if your change affects them.
