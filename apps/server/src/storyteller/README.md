# Storyteller (toddler mode)

A parent picks 4 to 9 books for a toddler's profile and sets a nightly allowance. The kid's
tablet opens a full-screen grid of big covers with one play button; audiobooks play through
Audiobookshelf, and picture books without audio are read aloud by the device's text-to-speech.
When tonight's allowance is used up, Barnaby says goodnight.

## Rules

- **Stories** come from the kid's shelf rows with `storyteller = true`
  (`PUT /api/shelves/kids/:kidId/books/:bookId { storyteller: true }`), filtered by the content
  lock as the kid and as the viewer. At most 9 are shown, in the order they were added.
- **Settings** (`storyteller_settings`): on/off, stories per night, minutes per night, default
  sleep timer, read-aloud on/off, time zone, and the hour a new night starts (default noon, so
  a story at 1 a.m. counts toward the evening before). Only a linked parent or an admin can
  change them; the kid gets 403 (CLAUDE.md rule 2).
- **Counting** (`storyteller_sessions`): the server credits listening time from heartbeats on
  its own clock, at most 45 s per beat, and only while the player says it's playing. A book
  counts as one of tonight's stories once it has had 20 s of listening.
- **Limits**: a story limit stops the *next* story, never the one playing; the story the kid was
  just on can be resumed (if it wasn't finished) while minutes remain. A minute limit stops the
  story mid-way: the next heartbeat answers `stop: true` and the session ends.
- **Audio guard**: for a kid with storyteller mode on, `GET /api/books/:id/audio/tracks/:index`
  only streams inside a live storyteller session for that book (heartbeat within 5 minutes)
  with minutes left; otherwise 403 `{ goodnight: true }`. This is a root-level `preHandler` hook,
  so `storytellerPlugin` is registered before the integrations plugin in `app.ts`. Adults and
  kids without storyteller mode are unaffected. Read-aloud books are counted by sessions the
  same way, but their EPUB stays readable in the normal reader.

## API

| Route | Who | |
| --- | --- | --- |
| `GET /api/storyteller/kids/:kidId` | kid (`me`), linked parent, admin | `{ kid, settings, canEdit, tonight, beatIntervalMs, stories[] }` |
| `PUT /api/storyteller/kids/:kidId/settings` | linked parent, admin | full settings object |
| `GET /api/storyteller/kids/:kidId/history?days=7` | kid, linked parent, admin | recent sessions with titles |
| `POST /api/storyteller/stories` | kid | `{ bookId, mode: "audio" \| "read_aloud" }` → 201 `{ session, tonight }`, or 409 `{ goodnight: true, tonight }` |
| `POST /api/storyteller/sessions/:id/beat` | kid | `{ playing }` → `{ stop, tonight }` |
| `POST /api/storyteller/sessions/:id/end` | kid | `{ playing, completed }` → `{ tonight }` |

Others get 404 for kids they can't see. Night math (`nightKey`, `tonightFrom`) lives in
`@bookbandit/shared` so the web demo mode uses the same rules.
