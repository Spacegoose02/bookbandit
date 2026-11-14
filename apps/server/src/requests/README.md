# Requests, downloads, uploads and the job runner (`ws/requests`)

Code: `src/jobs/` (runner), `src/requests/` (requests API), `src/downloads/` (downloaders, uploads).
Web: `apps/web/src/requests/` at `/requests`.

## Flow

```
kid asks ─▶ pending ─(linked parent or admin approves)─▶ approved ─▶ downloading ─▶ done (file in the inbox)
   │              └─(declined)─▶ declined                                   └──▶ failed (admin can retry)
   └─ rating known and above the kid's limit ─▶ declined at once
```

- **Anyone can request.** Adults' and parents' requests are approved by an admin; an admin's own
  are approved at once. A parent approves only their linked kids' requests and can't approve a
  book whose known rating is above that kid's limit (an admin can, for the library).
- **Rating guess.** The server looks the book up (Hardcover / Google Books / Open Library, same
  rules as the library's automatic ratings). The client never sends a rating. Unknown rating =
  pending, for a grown-up to judge; the book itself is rated again when it lands in the inbox.
- **Content lock.** Search marks "in library" through `visibleBooksWhere`; kids only see search
  results whose guessed rating is known and within their limit; a request's finished book is shown
  only when `assertCanSee` passes for the viewer (so it stays hidden until an admin approves it
  in the inbox with a fitting rating). Requests of other people answer 404.
- **Download** starts on approval when auto-download is on and a downloader is ready, trying
  them in the configured order. Files go to `BOOKS_DIR/_incoming/<kind>/<id>/` (written under the
  hidden `_incoming/.partial/` first), then a library scan adds them to the admin inbox and the
  request links to the new book.

## Downloaders (admin settings)

| Downloader | Needs | How |
| --- | --- | --- |
| [Shelfmark](https://github.com/calibrain/shelfmark) | URL + `SHELFMARK_API_KEY` | `/api/metadata/search` → `/api/releases` (EPUB preferred) → `/api/releases/download` → poll `/api/status` → `/api/localdownload` |
| sabnzbd | URL + API key, category, path map | NZB from a **Newznab indexer** (or a given NZB URL) → `addurl` → poll `queue`/`history` → copy book files from the completed folder |
| Direct URL | admin only | fetch, refuse web pages, size limit, `.zip` unpacked |

Keep Shelfmark's own download folder outside `/books` (Bookbandit fetches the file over the API).
For sabnzbd, mount its completed folder into the Bookbandit container and set the path map
(`/downloads/complete` in sabnzbd → e.g. `/sab-complete` here). API keys are sealed with
`CONFIG_DIR/secret.key` and never returned. Bookbandit never removes DRM: DRM files that arrive
stay unreadable and the scan reports them.

## API

| Method | Path | Who | What |
| --- | --- | --- | --- |
| `GET` | `/api/requests/search?q=` | signed in | Candidates (Open Library) with rating guess and `inLibrary` |
| `GET` | `/api/requests?scope=mine\|approvals\|all&status=` | signed in (`all`: admin) | Requests |
| `GET` | `/api/requests/summary` | signed in | `{ open, toApprove }` for badges |
| `POST` | `/api/requests` | signed in | `{ title, author?, isbn13?, coverUrl?, publishedYear?, note? }` → 201, 200 duplicate, 409 already in library, 429 too many open |
| `GET` | `/api/requests/:id` | requester or approver | One request |
| `POST` | `/api/requests/:id/approve` / `decline` | linked parent or admin | `{ note? }` |
| `DELETE` | `/api/requests/:id` | requester (pending) or admin | Withdraw |
| `POST` | `/api/admin/requests/:id/download` | admin | `{ via: auto\|shelfmark\|sabnzbd\|direct, url? }` start or retry |
| `GET/PUT` | `/api/admin/downloads/settings` | admin | Downloader, direct-download and upload settings |
| `POST` | `/api/admin/downloads/test` | admin | `{ client: shelfmark\|sabnzbd\|newznab }` |
| `POST` | `/api/admin/downloads` | admin | `{ url, via: direct\|sabnzbd, title? }` download into the inbox |
| `GET` | `/api/uploads/allowed` | signed in | `{ allowed, maxMb }` |
| `PUT` | `/api/uploads?filename=` | admin (adults/parents if allowed, never kids) | Raw file body → `_incoming/uploads/…`, then a scan job |
| `GET` | `/api/admin/jobs?status&type` | admin | Jobs with counts and registered types |
| `GET` | `/api/admin/jobs/:id` | admin | Job with payload and log |
| `POST` | `/api/admin/jobs/:id/retry` / `cancel` | admin | |

## Job runner for other workstreams

`app.jobs` is decorated on the root instance (registered in `app.ts` before other plugins):

```ts
app.jobs.register("ai.rate", async (payload, ctx) => {
  ctx.log("rating…");
  ctx.progress(0.5);
  // throw PermanentJobError to fail without retries; ctx.defer(ms) to poll later;
  // ctx.update(payload) to save state between deferrals; ctx.invoke("library.scan") to run another handler as a step
  return { done: true };
}, { maxAttempts: 3 });
const jobId = app.jobs.enqueue("ai.rate", { bookId }, { label: "Rate: The Hobbit" });
```

Retries back off 30 s, 1 min, 2 min … up to 1 h. Jobs left running by a restart are re-queued.
Tests don't start the poller: call `await app.jobs.drain()`. The library registers `library.scan`.
