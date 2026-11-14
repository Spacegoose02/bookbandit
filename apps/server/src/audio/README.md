# Audio (ws/audio)

Local audiobooks, one listening API for local and Audiobookshelf audio, and keeping positions in
step with Audiobookshelf while the family still uses its apps. The goal is that Audiobookshelf can
be switched off.

## Audiobook folder

`AUDIOBOOKS_DIR` (default `./data/audiobooks`, `/audiobooks` in Docker) is scanned when the server
starts (with `LIBRARY_SCAN_ON_START`), from **Admin → Audiobooks**, with
`POST /api/admin/audiobooks/scan`, or as the `audiobooks.scan` job.

- One folder per book, any depth: `Author/Title/`, `Author/Series/Book 2 - Title/`. Disc folders
  (`CD 1`, `Disc 2`, `Part 3`) belong to the book above them. A loose file at the top is a book.
- MP3, M4B, M4A, MP4/AAC, OGG/Opus, FLAC and WAV. Files play in natural file-name order.
- Chapters: M4B chapter atoms (`chpl`, or a QuickTime chapter track), otherwise one per file,
  named from the title tag or the file name.
- Metadata: album = title, album artist or artist = author, composer or narrator tag = narrator,
  ISBN tag, genre, year; the folder names fill gaps (author, series and position). Cover:
  `cover.jpg`/`folder.jpg` in the folder, else the embedded picture.
- Matching: same ISBN, or same title and author as an existing book (the library's own rule), joins
  that book, so the ebook and audiobook are one work. Otherwise a new book waits in the admin
  inbox, rated from its folders (`kids/`, `adult/` …) and tags, then the online lookup when on.
  Folder signals may only raise an approved book's rating, never lower it.
- Unchanged folders are skipped; a renamed or moved folder keeps its book (same file names and
  sizes); a folder that disappears loses its row, the book stays.
- Rejecting an audiobook in the inbox moves its files to `AUDIOBOOKS_DIR/.rejected/` (or deletes
  them), so a rescan leaves it out. Only its own tracks and cover are touched.

The `audiobooks` table is a cache of the folders and is rebuilt by rescanning.

## Listening API

Same shape for both sources; a local audiobook wins over an Audiobookshelf link. Every route goes
through the content lock: a locked book, one still in the inbox, or one without audio is a 404.
Storyteller's bedtime guard covers the track route for kids in storyteller mode.

| Route | |
| --- | --- |
| `GET /api/books/:id/audio` | `source`, tracks, chapters, duration, narrator, position, `prefs` |
| `GET /api/books/:id/audio/tracks/:index` | the audio with Range (local file, or proxied from ABS) |
| `GET /api/books/:id/audio/cover` | folder cover or book cover (local), ABS cover |
| `GET\|PUT /api/books/:id/audio/progress` | newest `clientUpdatedAt` wins; pushed to ABS |
| `PUT /api/books/:id/audio/prefs` | `{ speed?, skipSilence? }` per person per book |
| `GET\|POST /api/books/:id/audio/bookmarks` | `{ time, note? }`; `?since=<ms>` includes deletes |
| `PATCH\|DELETE /api/audio/bookmarks/:id` | your own bookmarks only (others are a 404) |
| `GET /api/audio/continue` | "keep listening" shelf |

Positions live in `audio_progress` (integrations schema). Its `abs_item_id` column holds the
source key: the ABS item id, or `local:<audiobook id>`. A position stored against either of the
book's current sources counts, so moving from ABS to a local copy of the same files keeps
everyone's place.

## Audiobookshelf, while both run

Each person can have their own ABS account: an admin pastes an ABS API key made for that ABS user
(ABS 2.26+: Settings → API Keys, "act as user"; older ABS: the user's API token) on
**Admin → Audiobooks**. It is checked against `/api/me`, sealed with the integrations key, and never
returned. Kids can't link or change their own.

| Route (admin) | |
| --- | --- |
| `GET /api/admin/audiobookshelf/accounts` | every person and their ABS link |
| `PUT /api/admin/audiobookshelf/accounts/:userId` | `{ token?, writeBack? }` |
| `DELETE /api/admin/audiobookshelf/accounts/:userId` | |
| `POST /api/admin/audiobookshelf/import` | `{ userIds?, dryRun? }`: positions, finished flags, bookmarks |

- **Write-back:** after a position is saved, it is pushed to ABS in the background
  (`PATCH /api/me/progress/:item`), coalesced per book. If ABS already has a newer position
  (`lastUpdate`), Bookbandit takes that one instead.
- **Pull:** opening the player asks ABS for the person's position first (2.5 s timeout); a newer
  one is used. ABS being down only means the local position.
- **Import:** only books linked to an ABS item take part (run auto-link under Connections first).
  Newer positions here are kept; bookmarks are matched by time so a second import adds nothing.

Code: `walk.ts` (folders), `probe.ts` and `mp4chapters.ts` (tags, durations, chapters),
`scanner.ts`, `sources.ts` (which audio a book plays), `routes.ts`, `files.ts` (inbox reject and
merge hooks), and `../integrations/audiobookshelf/{sync,accounts}.ts`. Tests: `test/audio.test.ts`.
