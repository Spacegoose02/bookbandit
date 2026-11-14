# Ops change log

Backups, end-to-end tests, hardening, performance and releases (`ws/ops`). Newest first.

- 2026-11-14: The Release workflow also starts the Android build on the new tag; a tag pushed by a workflow doesn't start the Android build that follows Docker, so v0.4.0 first shipped without its APK. The Android workflow can also be run by hand with a release tag to build that tag and attach the APK.
- 2026-11-14: **Release workflow**: Actions > Release > Run workflow with a version such as `0.4.0` checks CI passed on main, creates the `v0.4.0` tag and starts the Docker and desktop release builds (the Android APK follows the Docker run), so nobody has to push a tag by hand. Pushing a tag by hand still works.
- 2026-11-14: Nightly SQLite backups to `/config/backups` (keep 7), **Back up now** and downloads on the
  Admin page, and a `restore` command (`docker run … restore latest`) that also restores into a fresh
  container ([backup README](../../apps/server/src/backup/README.md), [Docker README](../../docker/README.md#backups)).
  Playwright end-to-end suite in CI ([e2e/README.md](../../e2e/README.md)): password and PIN sign-in,
  reading sync between two browsers, and the content lock through the web app, the API, OPDS, Kobo,
  KOReader, Barnaby, Discover and requests. Hardening: security headers and a Content-Security-Policy,
  paired devices expire after 180 idle days (`DEVICE_IDLE_DAYS`), a per-address limit on password
  guesses across usernames, and a blocking `pnpm audit --prod` job in CI; zod 4, drizzle-orm 0.45,
  nodemailer 10 and @fastify/static 10 to clear the high advisories. 20,000-book performance check
  in CI; five missing indexes (migration `0014_ops`) took OPDS "Recently added" from 15 s to 35 ms and
  the series list from 700 ms to 60 ms (this PR)
