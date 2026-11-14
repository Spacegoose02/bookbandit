# Read-aloud narration

The reader's **Read aloud** button (and storyteller mode for picture books) reads the book out loud
and lights up each word as it's spoken. Owned by `ws/readaloud`; web side in `apps/web/src/readaloud/`.

## What speaks, best first

1. **The book's own narrator.** EPUB3 books with media overlays (read-along books with recorded
   audio) are played by foliate-js in the browser. `GET /api/narration/status?bookId=` says
   `mediaOverlay: true` when the OPF has `media-overlay` items pointing at SMIL files.
2. **The family's speech server.** A local text-to-speech server with an OpenAI-compatible
   `/v1/audio/speech`: [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (recommended,
   gives word timings) or Piper behind [openedai-speech](https://github.com/matatonic/openedai-speech).
3. **The device's voice** (`speechSynthesis`) when no server is set up. Word highlighting uses the
   browser's word-boundary events.

## Set up Kokoro

```yaml
# docker-compose: next to bookbandit
kokoro:
  image: ghcr.io/remsky/kokoro-fastapi-cpu:latest   # or kokoro-fastapi-gpu
  restart: unless-stopped
```

Then as an admin open **Admin → Read-aloud** (`/readaloud/settings`), pick the Kokoro preset
(`http://kokoro:8880/v1`, model `kokoro`), and press **Save and test**. Kids get the kids' voice
(`af_bella` by default); everyone can pick their own voice and speed from the read-aloud bar, and a
parent can set a kid's from the family page.

With **word timings** on, the server asks Kokoro's `/dev/captioned_speech` for per-word timestamps.
Servers without that endpoint (Piper) are remembered and get plain `/v1/audio/speech`; the web app
then estimates each word's timing from its position in the sentence.

## How it works

- The web app takes one block of text at a time from foliate-js (SSML with a `<mark>` before every
  word), splits it into chunks of whole sentences (≤ 280 characters), and asks
  `POST /api/narration/speech {bookId, text}` for each, fetching the next chunk while one plays.
- The server checks the content lock as the reader (locked book → 404), picks the reader's voice
  and speed, and returns `{id, url, words}`. Audio is cached on disk in
  `CONFIG_DIR/cache/narration/<sha256>.mp3` (+ `.json` with the word timings), keyed by server,
  model, voice, speed and text. A chapter read once plays instantly next time, for every reader
  with the same voice. Oldest clips are dropped past the admin's limit (default 500 MB); deleting
  the folder is always safe.
- `GET /api/narration/clips/:id` serves a clip (Range supported). Ids are SHA-256 hashes.

## API

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/narration/status?bookId=` | signed in; book must be visible |
| GET | `/api/narration/voices` | signed in |
| GET/PUT | `/api/narration/people/:userId` (`me`) `{voice, speed}` | self, linked parent, admin |
| POST | `/api/narration/speech` `{bookId, text, voice?}` | signed in; book must be visible |
| GET | `/api/narration/clips/:id` | signed in |
| GET/PUT | `/api/admin/narration/settings` | admin |
| POST | `/api/admin/narration/test` | admin |
| DELETE | `/api/admin/narration/cache` | admin |

Tables: `narration_prefs` (this folder's `schema.ts`, migration `0009_readaloud`). Settings live in
the `settings` table under `narration.settings`; the API key is sealed with `CONFIG_DIR/secret.key`.
