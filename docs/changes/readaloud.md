# Read-aloud and learning changes (`ws/readaloud`)

- 2026-11-14: Read aloud in the reader with word-by-word highlighting: EPUB3 media overlays first, then a local Kokoro/Piper speech server (word timings from Kokoro, per-person voice and speed, audio cached on disk), then the device's voice. Storyteller uses the server voice for picture books. Tap a word for a kid-friendly meaning and "say it" (family word list, offline dictionary, then Barnaby when a parent allows). Three-question quizzes after a chapter (Barnaby or offline), with cheers, logged on the family page. Admin settings at `/readaloud/settings`. Migration 0008. See `apps/server/src/narration/README.md` and `apps/server/src/learning/README.md` (this PR)

Screenshots for this area: build, `vite preview --port 4173`, then `node apps/web/scripts/screenshots-readaloud.cjs`.
