# Architecture (summary)

This is the plan of record for the repository. (An earlier, longer planning doc exists outside the
repo; everything an implementer needs from it is captured here and in the other files in `docs/`.)

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

## Family accounts

- Roles: `admin` (downloads, uploads, settings, approvals), `parent`, `adult`, `kid`.
- A kid is always linked to at least one parent (`parent_links`). Kids sign in with their own Google
  account through Tinyauth (linked by a parent), a username + PIN/picture password, or by tapping
  their picture on a tablet a parent already paired. Only parents/admins change a kid's age, links,
  sign-in method or AI settings.
- Tablets pair once by scanning a QR code a parent shows; they get a revocable device token.

## Reading

- Formats: EPUB, KEPUB, MOBI/AZW3 (DRM-free only), FB2, PDF, CBZ/CBR; audio via Audiobookshelf.
- Progress locator per format (EPUB CFI, page, seconds); newest timestamp wins; offline changes queue.
- Bookmarks, highlights, and kid "stickers" per person.
- Themes: Dark, Nuclear, Retro, Pink, School, Gaming, Dinosaur, Storm. Kid mode: big fonts,
  dyslexia-friendly font, tap a word to hear it.
- Storyteller mode (toddlers): grid of 4–9 parent-chosen covers, one play button, sleep timer,
  nightly limit, Android screen pinning; audiobooks, picture books with audio, EPUB3 read-along.

## Library

- `/books` is watched; new files land in `/books/_incoming`, are matched to metadata, and move to
  `Author/Series/Title` after admin approval. Anything in `/books/adult` is rated adult.
- Series from metadata (Hardcover best for order) plus admin-made series. Tags with kinds `genre`,
  `section` (kids, cookbook shelves), `custom`. Collections. Filters: author, series, year range,
  format, language, age group, read/unread, has audiobook.
- Requests (anyone; kid requests above their rating are auto-declined), duplicate finder (ISBN,
  fuzzy title/author, file hash), Discover/trending from Hardcover and Open Library.

## Kindle

No DRM removal (illegal under DMCA 1201). Kindle purchases are metadata-only `kindle_only` books with
a "Read in Kindle" link. Send to Kindle emails EPUB/PDF to a profile's `@kindle.com` address over SMTP.

## AI (optional)

- One provider setting per feature: local (Ollama, LM Studio, llama.cpp, any OpenAI-compatible
  server) or cloud (Claude, OpenAI, Gemini). Web search via SearXNG (or Brave/Tavily). Embeddings via
  nomic-embed-text + sqlite-vec. Voice: Piper/Kokoro TTS, Whisper STT. Usage log per feature.
- Features: rating helper, metadata cleanup, meaning search, more-like-this, spoiler-free chat
  limited to pages already read, smart requests, web answers with sources, cookbook helper, AI
  narration, quizzes and word help.
- Kid AI mode: Barnaby (the raccoon mascot) is the avatar; answers only within the content lock;
  web search off unless a parent enables it (SearXNG strict safe search + allowlist); moderation on
  input and output; never asks for personal details; every chat logged in `ai_messages` for the
  parent dashboard; no chat under age 5.

## Branding

Barnaby, the book-nerd raccoon, is the face of Bookbandit: logo, app icon, empty and loading states,
celebrations, and the avatar in every AI chat bubble. Brand assets go in `apps/web/public/brand/`.
