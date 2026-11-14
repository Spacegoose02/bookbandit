# Bookbandit

A self-hosted family library and reader for your Unraid server. Bookbandit aims to replace
Calibre, Calibre-Web and Kavita in one container, link up with Audiobookshelf, and be simple
enough for a 7-year-old to use.

> Status: early foundation. Not ready to run against a real library yet.

## What's planned

- One library for ebooks, comics, PDFs and audiobooks (via Audiobookshelf)
- Web reader and an Android tablet app, with progress and bookmarks synced per person
- Kid accounts linked to a parent, with a server-enforced lock on mature and explicit books
- Storyteller mode for toddlers
- Requests and admin-only downloads (Shelfmark, sabnzbd, direct links)
- Send to Kindle by email, Kobo and KOReader sync, OPDS
- Optional AI (local through Ollama, or a cloud API) with a stricter kid mode

The full plan lives in [docs/architecture.md](docs/architecture.md).

## Development

Requires Node 22 and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm --filter @bookbandit/shared build
pnpm test
pnpm dev          # API on :8080, web on :5173 (proxies /api)
```

Layout:

| Path | What |
| --- | --- |
| `packages/shared` | Types and rules shared by server, web and app (content ratings, roles, progress) |
| `apps/server` | Fastify API, SQLite database (Drizzle), background jobs |
| `apps/web` | React web app and reader |
| `docs/` | Architecture and workstream notes |

## Docker

See `docker-compose.example.yml`. Mount `/config` (database, covers) and `/books` (your library).
