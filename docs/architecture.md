# Architecture (summary)

The living plan, with diagrams, is the "Bookbandit: architecture and roadmap" doc in the project.
This file is the short version for the repo.

## Shape

- One Docker container: Fastify API + React web app + background job queue, SQLite in `/config`,
  books as plain files in `/books`.
- Clients: web reader (PWA), Android tablet app (Capacitor, same React code), later Kobo/KOReader/OPDS.
- Auth: Tinyauth (Google) in front of the app for adults and older kids; device tokens via QR pairing
  for tablets; PIN or picture sign-in for young kids. Kids are always linked to a parent.
- Outside services: Audiobookshelf (audio), Shelfmark/sabnzbd (admin downloads), Hardcover/Open
  Library/Google Books (metadata), SMTP (Send to Kindle), optional AI providers (Ollama or cloud),
  SearXNG (web search for AI).

## Content lock

Ratings: `kids` < `middle_grade` < `teen` < `adult` < `explicit`. A kid's limit comes from their
birth year (8 → middle grade, 13 → teen, 18 → adult). Explicit needs an adult's own opt-in.
Unrated = adult. Enforced on the server for every query (see `apps/server/src/content/lock.ts`).

## Roadmap

1. **Core reader (MVP):** Docker/Unraid, Tinyauth, family accounts + content lock, scan `/books`,
   metadata, web reader + sync, EPUB/PDF/CBZ, series/filters/kids shelves, Audiobookshelf player,
   Send to Kindle.
2. **Tablets and requests:** Android app, offline, QR pairing, storyteller mode, requests,
   Shelfmark/sabnzbd/direct downloads, uploads inbox, AI rating helper and metadata cleanup.
3. **Polish and devices:** themes + mascot, duplicate finder, discover/trending, cookbook view,
   Kobo/KOReader/OPDS, Kindle library import, AI helper and kid AI.
4. **Own the audio (optional):** built-in audiobook player, replace Audiobookshelf.
