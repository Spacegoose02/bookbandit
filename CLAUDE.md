# Bookbandit: notes for contributors and agents

Self-hosted family book library + reader. TypeScript pnpm monorepo. Read `docs/architecture.md`
for the plan, `docs/workstreams.md` for who owns what and the per-PR rules (screenshots,
roadmap, change log, staying mergeable), `docs/ROADMAP.md` for progress and `docs/HANDOFF.md` for current state.

## Commands

- `pnpm install`
- `pnpm --filter @bookbandit/shared build` (other packages import its `dist/`)
- `pnpm typecheck` and `pnpm test` must pass before every push
- `pnpm --filter @bookbandit/server db:generate` regenerates SQL migrations from the Drizzle schema

## Rules that must never break

1. **Content lock is server-side.** Any endpoint, feed (OPDS), search, recommendation or AI
   answer that returns books to a reader filters with `visibleBooksWhere(reader)` or checks
   `assertCanSee(reader, book)` from `apps/server/src/content/lock.ts`. Locked books return 404,
   not 403. Unrated books are treated as adult. Add a test for every new book-returning endpoint.
2. **Kids can't change their own limits.** Only `parent`/`admin` can edit a kid's birth year,
   parent links, sign-in method, or AI settings.
3. **Auth headers are trusted only from `TRUSTED_PROXIES`.**
4. **Downloads, uploads, settings and Shelfmark are admin-only** (`requireAdmin`).
5. **No DRM removal**, ever. Kindle purchases are metadata-only entries.
6. **Files stay plain files** under `/books`; the database must be rebuildable by rescanning
   (except people, progress, bookmarks and admin-set ratings/series).

## Conventions

- ESM everywhere, `.js` suffix on relative imports in server/shared.
- Validate request input with zod.
- Database: SQLite via Drizzle, ids are UUID text, timestamps are integer ms.
- New tables for a workstream go in the schema file for that area; keep schema changes additive.
  Only one migration per PR: rebase on `main`, then run `db:generate` so numbering stays linear.
- Shared types and rules that the web/app also need go in `packages/shared`.
- Keep PRs to one workstream area; touch other areas only for small, necessary hooks.
