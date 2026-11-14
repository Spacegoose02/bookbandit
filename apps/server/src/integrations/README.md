# Integrations

## Audiobookshelf

Admin setup: `PUT /api/admin/integrations/audiobookshelf` with `{ url, token, libraryIds? }`
(token from ABS → Settings → Users → your user → API token). `POST .../test` checks it.
The token is sealed (AES-256-GCM, key in `CONFIG_DIR/secret.key`) and never sent to clients.

Linking: `POST /api/admin/audiobookshelf/auto-link` (`{ dryRun }`) matches by ISBN, then ASIN,
then title + author surname, and only links unambiguous matches. `GET /api/admin/audiobookshelf/items?q=&unlinked=true`
and `PUT|DELETE /api/admin/books/:id/audiobookshelf` cover the rest by hand.

Playback, listening positions, bookmarks and player settings for readers are served by the audio
workstream through one API for Audiobookshelf and local audiobooks: see
[`src/audio/README.md`](../audio/README.md). That is also where each person's ABS account, the
progress import and write-back to ABS are documented.

## Send to Kindle

Admin setup: `PUT /api/admin/integrations/smtp` with `{ host, port, secure, user, password, from }`,
then `POST .../test` with `{ to }`. Add the `from` address to each Kindle's
"Approved Personal Document E-mail List" on Amazon.

Addresses: `PUT /api/kindle/addresses/:userId` with `{ email }`. Only `@kindle.com`,
`@free.kindle.com` and `@kindle.cn`. Adults set their own; a kid's is set by a linked parent or an admin.
`GET /api/kindle/me` tells the UI whether to show the button.

Sending: `POST /api/books/:id/send-to-kindle` (`{ format?: "epub" | "pdf" }`, EPUB preferred).
Content lock applies, 50 MB Amazon limit, 20 sends per person per hour. Plain files only, no DRM handling.
