# Listening, Send to Kindle and storyteller changes (`ws/listen`)

- 2026-11-14: Web audiobook player (`/listen/:id`: speed, ±30 s, chapters, sleep timer with fade-out, lock-screen controls, listening progress sync), Send to Kindle button and Kindle address setting, toddler storyteller (`/storyteller`: 4 to 9 big covers, one play button, sleep timer, read-aloud fallback, Barnaby's goodnight), parent setup (`/storyteller/setup`), server-enforced nightly limits (migration 0004, see `apps/server/src/storyteller/README.md`) (#17)

Screenshots for this area: build, `vite preview --port 4173`, then `node apps/web/scripts/screenshots-listen.cjs`.
