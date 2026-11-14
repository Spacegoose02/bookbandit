# Roadmap

Checked items are merged to `main`. Tick your item in the same PR that finishes it, and only edit
your own workstream's lines. Items are kept one blank line apart so that two PRs ticking
neighbouring items still merge cleanly; keep that spacing when adding items.
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

- [x] Audiobookshelf: link and play audiobooks, listening progress (`ws/integrations` server API, `ws/listen` web player with speed, ±30 s, chapters, sleep timer)

- [x] Send to Kindle by email (`ws/integrations` server API, `ws/listen` button and address setting)

## Phase 2: Tablets and requests

Goal: kids read on their own tablets and Kavita is switched off.

- [ ] Android tablet app (Capacitor) with offline downloads (`ws/android`): built (QR pairing, offline downloads and cache, screen pinning, PIN-locked settings, CI APK on releases); tick once tested on a real Fire and Android tablet
- [ ] Windows desktop app (Tauri) (`ws/desktop`): built (server setup and pairing, offline reading with progress sync, installer attached to releases); tick once tested on a real Windows PC

- [ ] Storyteller mode for toddlers: big covers, play button, sleep timer, server-enforced nightly limits, read-aloud fallback and Barnaby's goodnight are done (`ws/listen`); screen pinning (`ws/android`)

- [x] Book requests with parent/admin approval (`ws/requests`)

- [x] Shelfmark, sabnzbd and direct downloader, admin only, on a generic job runner (`ws/requests`)

- [x] Browser uploads into the inbox (`ws/requests`)

- [ ] Admin UI: inbox approval, rating review, scan status, users and kids, integration settings (`ws/admin`)

- [ ] Parent dashboard: reading, requests, kid AI chats (`ws/admin`; reading-time API done by the lead)

- [x] Admin UI: inbox approval with metadata edit and merge, rating review, scan status, users and kids, paired devices, Audiobookshelf/SMTP/metadata settings (`ws/admin`)
- [x] Parent dashboard: reading, requests, kid AI chats (`ws/admin`; request approval buttons wait for `ws/requests`, chats fill once `ws/ai` logs them)
- [x] AI provider settings (Ollama / OpenAI-compatible / Anthropic / Gemini), usage log, AI rating helper (`ws/ai`, [ai.md](ai.md))
- [ ] AI metadata cleanup (`ws/ai`)

## Phase 3: Polish and devices

Goal: the Calibre desktop app is no longer needed.

- [ ] Duplicate finder UI (`ws/admin`; detection exists in the library service)

- [ ] Duplicate finder UI (`ws/admin`; the inbox shows likely duplicates and merges them, a library-wide duplicates page is still to do)
- [x] Discover and trending, series pages, admin-made series, category browsing (`ws/discover`; "Request it" calls `POST /api/requests` once `ws/requests` lands)

- [x] Cookbook view (`ws/discover`: Cook mode keeps the screen on, big scrolling text, recipe index)

- [x] Kobo sync, KOReader sync, OPDS feed (`ws/ereader`; physical Kobo test pending)

- [x] Kindle library import (metadata-only, "Read in Kindle") (`ws/discover`)

- [x] AI: ask your library, spoiler-free book chat, web answers via SearXNG with sources (`ws/ai`)
- [ ] AI: more like this, smart requests, meaning search (embeddings), streaming replies (`ws/ai`)

- [x] Kid AI mode with Barnaby (moderation, personal-detail removal, parent log, daily limits, no chat under 5) (`ws/ai`)

- [x] AI narration (Piper/Kokoro) and quizzes/word help (`ws/readaloud`: word highlighting, EPUB3 read-along, tap-a-word help, after-chapter quizzes on the family page)

## Phase 4: Own the audio (optional)

Goal: Audiobookshelf can be switched off.

- [ ] Built-in audiobook player (speed, chapters, sleep timer)

- [ ] Audiobook folder scan

- [ ] Import Audiobookshelf progress

- [ ] Read-along (EPUB3 media overlays)
