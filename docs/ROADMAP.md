# Roadmap

Checked items are merged to `main`. Update this file in the same PR that finishes an item.
The full plan with diagrams is the "Bookbandit: architecture and roadmap" doc in the project.

## Phase 1: Core reader (MVP)

Goal: the family reads in Bookbandit every day and Calibre-Web is switched off.

- [x] Monorepo, CI, Dockerfile foundation
- [x] Core data model (households, parent-linked kids, books, series, progress, bookmarks, requests, jobs, AI log)
- [x] Server-side content lock (kids/middle grade/teen/adult/explicit, unrated = adult) with tests
- [x] Tinyauth sign-in, trusted only from the reverse proxy
- [ ] Family accounts: kid accounts under a parent, PIN/picture sign-in, QR device pairing, local password fallback (`ws/auth`)
- [ ] Scan `/books`, read file metadata, Open Library / Google Books / Hardcover lookup, inbox approval (`ws/library`)
- [ ] Ratings from metadata, keywords and the `/books/adult` folder (`ws/library`)
- [ ] Reading progress, bookmarks, highlights, stickers, Continue reading and kid shelves API (`ws/sync`)
- [ ] Web app: shelves, filters (author, year range, age group), series, kids section (`ws/web`)
- [ ] Web reader (foliate-js) for EPUB, PDF and CBZ with progress sync (`ws/web`)
- [ ] Theme system: Dark, Nuclear, Retro, Pink, School, Gaming, Dinosaur, Storm (`ws/web`)
- [ ] Barnaby branding: logo, icon, empty states (`ws/web`)
- [ ] Docker image serving the web app, ebook-convert, kepubify, PUID/PGID, GHCR, Unraid template (`ws/docker`)
- [ ] Audiobookshelf: link and play audiobooks, listening progress (`ws/integrations`; server API done, player UI is `ws/web`)
- [ ] Send to Kindle by email (`ws/integrations`; server API done, button and settings UI are `ws/web`)

## Phase 2: Tablets and requests

Goal: kids read on their own tablets and Kavita is switched off.

- [ ] Android tablet app (Capacitor) with offline downloads
- [ ] Storyteller mode for toddlers (big covers, play button, bedtime limits, screen pinning)
- [ ] Book requests with parent/admin approval
- [ ] Shelfmark, sabnzbd and direct downloader (admin only)
- [ ] Browser uploads into the inbox
- [ ] Parent dashboard (reading, requests, kid AI chats)
- [ ] AI provider settings (Ollama / OpenAI-compatible / cloud), AI rating helper, AI metadata cleanup

## Phase 3: Polish and devices

Goal: the Calibre desktop app is no longer needed.

- [ ] Duplicate finder
- [ ] Discover and trending
- [ ] Cookbook view
- [ ] Kobo sync, KOReader sync, OPDS feed
- [ ] Kindle library import (metadata-only, "Read in Kindle")
- [ ] AI: ask your library, more like this, spoiler-free chat, smart requests, web answers via SearXNG
- [ ] Kid AI mode with Barnaby (moderation, parent log, limits)
- [ ] AI narration (Piper/Kokoro) and quizzes/word help

## Phase 4: Own the audio (optional)

Goal: Audiobookshelf can be switched off.

- [ ] Built-in audiobook player (speed, chapters, sleep timer)
- [ ] Audiobook folder scan
- [ ] Import Audiobookshelf progress
- [ ] Read-along (EPUB3 media overlays)
