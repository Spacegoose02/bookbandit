# Roadmap

Checked items are merged to `main`. Update this file in the same PR that finishes an item.
Workstream names refer to [workstreams.md](workstreams.md).

## Phase 1: Core reader (MVP)

Goal: the family reads in Bookbandit every day and Calibre-Web is switched off.

- [x] Monorepo, CI, Dockerfile foundation
- [x] Core data model (households, parent-linked kids, books, series, progress, bookmarks, requests, jobs, AI log)
- [x] Server-side content lock (kids/middle grade/teen/adult/explicit, unrated = adult) with tests
- [x] Tinyauth sign-in, trusted only from the reverse proxy
- [x] Family accounts: kid accounts under a parent, PIN/picture sign-in, QR device pairing, local password fallback (`ws/auth`)
- [x] Web sign-in screen and own-profile editor (`ws/auth`)
- [x] Scan `/books`, read file metadata, Open Library / Google Books / Hardcover lookup, inbox approval (`ws/library`)
- [x] Ratings from metadata, keywords and the `/books/adult` folder (`ws/library`)
- [x] Reading progress, bookmarks, highlights, stickers, Continue reading and kid shelves API (`ws/sync`)
- [x] Web app: shelves, filters (author, year range, age group), series, kids section (`ws/web`; needs the lead's `/api/shelves` and `/api/books` filters to show real data)
- [x] Web reader for EPUB, AZW3/MOBI, FB2, CBZ (foliate-js) and PDF (pdf.js) with progress sync
- [x] Theme system: Dark, Nuclear, Retro, Pink, School, Gaming, Dinosaur, Storm (`ws/web`)
- [x] Barnaby branding: logo, icon, empty states (`ws/web`)
- [x] Docker image serving the web app, ebook-convert, kepubify, PUID/PGID, GHCR, Unraid template (`ws/docker`), released as v0.1.0
- [ ] Audiobookshelf: link and play audiobooks, listening progress (server API done; web player is `ws/listen`)
- [ ] Send to Kindle by email (server API done; button and address setting are `ws/listen`)

## Phase 2: Tablets and requests

Goal: kids read on their own tablets and Kavita is switched off.

- [ ] Android tablet app (Capacitor) with offline downloads (`ws/android`)
- [ ] Storyteller mode for toddlers: big covers, play button, bedtime limits (`ws/listen`); screen pinning (`ws/android`)
- [ ] Book requests with parent/admin approval (`ws/requests`)
- [ ] Shelfmark, sabnzbd and direct downloader, admin only, on a generic job runner (`ws/requests`)
- [ ] Browser uploads into the inbox (`ws/requests`)
- [x] Admin UI: inbox approval with metadata edit and merge, rating review, scan status, users and kids, paired devices, Audiobookshelf/SMTP/metadata settings (`ws/admin`)
- [x] Parent dashboard: reading, requests, kid AI chats (`ws/admin`; request approval buttons wait for `ws/requests`, chats fill once `ws/ai` logs them, minutes read wait for reading sessions)
- [ ] AI provider settings (Ollama / OpenAI-compatible / cloud), AI rating helper, AI metadata cleanup (`ws/ai`)

## Phase 3: Polish and devices

Goal: the Calibre desktop app is no longer needed.

- [ ] Duplicate finder UI (`ws/admin`; the inbox shows likely duplicates and merges them, a library-wide duplicates page is still to do)
- [ ] Discover and trending, series pages, admin-made series, category browsing (`ws/discover`)
- [ ] Cookbook view (`ws/discover`)
- [ ] Kobo sync, KOReader sync, OPDS feed (`ws/ereader`)
- [ ] Kindle library import (metadata-only, "Read in Kindle") (`ws/discover`)
- [ ] AI: ask your library, more like this, spoiler-free chat, smart requests, web answers via SearXNG (`ws/ai`)
- [ ] Kid AI mode with Barnaby (moderation, parent log, limits) (`ws/ai`)
- [ ] AI narration (Piper/Kokoro) and quizzes/word help

## Phase 4: Own the audio (optional)

Goal: Audiobookshelf can be switched off.

- [ ] Built-in audiobook player (speed, chapters, sleep timer)
- [ ] Audiobook folder scan
- [ ] Import Audiobookshelf progress
- [ ] Read-along (EPUB3 media overlays)
