# Barnaby, the AI helper

Barnaby the raccoon is BookBandit's face and its optional AI helper. He can:

- **Chat with grown-ups** about the family library: recommendations from books you actually have, questions,
  and web answers with numbered sources.
- **Chat with kids** at their age level, only about books they're allowed to see, with moderation, a daily
  limit and a log their parents can read.
- **Talk about the book you're reading without spoilers**: he only gets the text up to your position.
- **Suggest ratings for unrated books** (the rating helper) for the admin review queue.
- **Find books by what they're about** (meaning search), under the normal library search.
- **"More like this"** on every book page, and **"Find a book"** for grown-ups ("something like Pixel Quest for a
  10-year-old").
- **Tidy up messy metadata** (titles, authors, series, descriptions), one field at a time with an admin's OK.

AI is off until an admin adds a provider. Nothing leaves your house unless you pick a cloud provider or turn on
web search.

## Quick start (everything local)

1. Run [Ollama](https://ollama.com) next to BookBandit and pull a chat model and a safety model:

   ```yaml
   # docker-compose.yml, next to the bookbandit service
   ollama:
     image: ollama/ollama
     volumes: [./data/ollama:/root/.ollama]
     # GPU (NVIDIA): add `gpus: all`, or `runtime: nvidia` on Unraid
   ```

   ```sh
   docker compose exec ollama ollama pull llama3.2        # chat (3B, fine on a CPU)
   docker compose exec ollama ollama pull llama-guard3:1b # moderation for kids
   ```

2. Sign in as an admin and open **Barnaby → Barnaby settings** (`/barnaby/settings`).
3. **Add provider → Ollama (local)**. Base URL `http://ollama:11434/v1`, model `llama3.2`. Add a second one for
   `llama-guard3:1b`. **Save settings**, then **Test** each.
4. Under **Who does what**: Grown-up chat → Ollama, Moderation → Llama Guard, Rating helper → Ollama. Save.
   For meaning search, also `ollama pull nomic-embed-text`, add **Ollama embeddings (for meaning search)** and pick
   it for **Meaning search**.
5. Turn Barnaby on for each kid at **Barnaby → Kids' Barnaby chats** (`/barnaby/family`).

The floating Barnaby button now appears on every page. In the reader or on a book page he chats about that book.

## Providers

Every feature (grown-up chat, kid chat, book chat, moderation, rating helper, metadata cleanup, meaning search) can
use a different provider. Kid chat, book chat and metadata cleanup use the grown-up chat provider unless you set them. API keys are encrypted in the
database with `CONFIG_DIR/secret.key` and are never sent back to the browser.

| Provider | Kind | Base URL | Model examples | Key |
| --- | --- | --- | --- | --- |
| Ollama | OpenAI-compatible | `http://ollama:11434/v1` (or `http://<host-ip>:11434/v1`) | `llama3.2`, `qwen2.5:7b`, `llama3.1:8b` | none |
| LM Studio | OpenAI-compatible | `http://<pc-ip>:1234/v1` (Developer → Start server, "Serve on local network") | the model id LM Studio shows | none |
| llama.cpp `llama-server` | OpenAI-compatible | `http://<host>:8080/v1` | anything (it serves one model) | `--api-key` if you set one |
| vLLM, LocalAI, OpenRouter | OpenAI-compatible | their `/v1` URL | per server | per server |
| OpenAI | OpenAI-compatible | `https://api.openai.com/v1` | use **Load models** to pick | platform.openai.com → API keys |
| Anthropic (Claude) | Anthropic | default (`https://api.anthropic.com`) | `claude-haiku-5-5` (cheap, fast), `claude-sonnet-5-5`, `claude-opus-5-5` (most capable) | console.anthropic.com → API keys |
| Google Gemini | Gemini | default (`https://generativelanguage.googleapis.com/v1beta`) | `gemini-2.5-flash` | aistudio.google.com → Get API key |

**Load models** lists what the provider offers. **Test** sends "say hello" and shows the answer and time. For an embeddings model (meaning search) it embeds a short text instead and shows the vector size. Claude has no embeddings API, so it can't be picked for meaning search.

Tips:

- On a CPU-only server, a 3B model (`llama3.2`) answers in a few seconds; 7 to 8B models are better but slower.
  Raise the timeout by editing the provider through the API (`timeoutMs`, up to 10 minutes) if replies time out.
- If BookBandit runs in Docker and Ollama on the host, use the host's LAN IP, not `localhost`. Ollama must listen
  on it: set `OLLAMA_HOST=0.0.0.0`.
- Ollama's default context is small. For book chat, use a model with at least 8k context (or set `num_ctx` in a
  Modelfile); Barnaby sends up to about 24,000 characters of book text.

## Moderation

Kids are always moderated, on what they send and on what Barnaby answers:

1. A built-in word filter (always on, no model needed).
2. The **Moderation** provider, if you pick one. Any chat model works (it's asked for `{"flagged": …}`), and
   Llama Guard models (`llama-guard3:1b`, `llama-guard3:8b`) are understood natively. If the check fails or
   times out, a kid's message is treated as flagged.

A flagged question never reaches the chat model; Barnaby gives a gentle answer instead (and, for anything that
sounds like self-harm, tells the kid to talk to a grown-up they trust right away). A flagged answer is replaced.
The chat is marked ⚠️ in the parent log. Grown-ups' chats are only moderated when "Also moderate grown-ups' chats"
is on.

## Kid mode

- **Off until a parent turns it on**, per kid, at `/barnaby/family`. Only a linked parent or an admin can change it;
  kids can read their own settings but not change them.
- **No chat under 5**, and no chat for a kid without a birth year.
- **Daily limit** (default 30 questions; the default is in settings, each kid can differ). Midnight is the server's
  time zone, so set `TZ` on the container.
- **Content lock**: Barnaby only hears about books the kid can open (`visibleBooksWhere`) and only recommends those.
  Book links in old chats disappear if the book is re-rated above the kid.
- **Personal details** (e-mail, phone, street address, long numbers, links) are removed before the message reaches
  the model or the log. Links Barnaby makes up are removed from kids' answers unless they are cited sources.
- **Parent log**: every kid message is kept in `ai_messages`. Kids can't delete their chats.
- **Web search** is off unless the parent allows it; then it's SearXNG with strict safe search, and only results
  from the kid allowlist are used (Britannica Kids, Nat Geo Kids, DK Find Out, Wonderopolis, NASA Space Place,
  Simple English Wikipedia and a few more; edit the list in settings).

## Web search (SearXNG)

1. Run [SearXNG](https://docs.searxng.org):

   ```yaml
   searxng:
     image: searxng/searxng
     volumes: [./data/searxng:/etc/searxng]
     environment:
       - SEARXNG_BASE_URL=http://searxng:8080/
   ```

2. Enable the JSON API in `./data/searxng/settings.yml` (it's off by default) and restart SearXNG:

   ```yaml
   search:
     formats:
       - html
       - json
   ```

3. In Barnaby settings, turn on **Let Barnaby search the web**, set the URL to `http://searxng:8080`, save, and
   press **Test a kid search**.

Grown-ups tick **Search the web** in the chat; Barnaby searches, reads the top results (5 by default) and cites
them as [1], [2], with the links under the answer. Safe search for grown-ups is "moderate" by default.

## Streaming replies

Grown-ups see Barnaby's answer appear as he writes it (`POST /api/ai/chat/stream`, server-sent events). Kids' answers,
and any chat that's moderated, are checked first and arrive whole, so a reply that moderation replaces is never shown
half-written. Every provider streams; an OpenAI-compatible server that ignores `stream: true` still works.

## More like this

Every book page has a **More like this** row. It needs no AI: books in the same series, by the same author or with
the same genres are found in the database. With meaning search on, books with a similar story are mixed in. The
list starts from what the reader may open, so a kid never sees a book above their rating there, and asking about a
book they can't open is a 404.

## Meaning search (embeddings)

1. `docker compose exec ollama ollama pull nomic-embed-text` (or use OpenAI `text-embedding-3-small`, or Gemini
   `text-embedding-004`; Claude has no embeddings API).
2. Add a provider with that model and pick it for **Meaning search** under **Who does what**. Save.
3. Indexing starts on the job runner (`ai.embed`, visible on the admin jobs page). Progress is under **Meaning
   search** in Barnaby settings. Each book's title, authors, series, genres and description (or the opening of the
   text when there's no description) become one vector in `ai_book_embeddings`. Only changed books are re-embedded.
   New books are picked up when someone searches (at most every 10 minutes) or with **Index new and changed books**.

Searching the library then also shows **"Barnaby also found, by what they're about"** under the title and author
matches. Kids get meaning search only when Barnaby is turned on for them, and only over books they may open. The
index is a cache: delete the rows (or change the model) and it rebuilds.

## Find a book (smart requests)

`/barnaby/find`, for grown-ups. Type "something like Pixel Quest for a 10-year-old" or "a cozy mystery with no
gore". Barnaby works out the example titles, the age and the topics, searches the library (more like the example,
meaning search, genres) behind the content lock and an age cap (10 → middle grade and younger; unrated books are left
out under any cap), then picks the best few and says why. Pick a kid in **For** and their own limit applies too.
He also names up to three well-known books the library doesn't have, each with a **Request it** button. A title the
library already has is never offered there, so this can't hint at a locked book. Kids find books by chatting instead.

## Metadata cleanup

Under **Metadata cleanup** in Barnaby settings, **Check the next 25** asks the metadata provider to look at books it
hasn't seen (or **Check all in the background** for every book left): file-name junk in titles, ALL CAPS, "Last, First" author names, a series stuck in the title, HTML or ads in
descriptions. Each changed field is a separate suggestion showing old → new. **Accept** applies that one field;
**Dismiss** hides it, and the same suggestion isn't made again. Nothing changes without an admin. Runs on the job runner
(`ai.metadata`). A series an admin manages isn't changed.

## Rating helper

At the bottom of Barnaby settings, **Rate the next 25** asks the rating-helper provider to rate books that
have no rating yet (and no suggestion yet), from the title, authors, genres, description, folder and the opening of the text. It's
fail-closed:

- A suggestion **stricter** than the current rating (unrated counts as adult) is applied at once, as an `ai`
  rating. It can only hide a book from kids, never show one.
- Anything else waits for an admin where the book already is, with Barnaby's pick outlined (✨) and his reasons:
  new books in the **Inbox**, library books on **Needs a rating**. **Accept** (or tapping his pick) stores an admin
  rating. Rating a book any other way settles his suggestion too, so a book never waits in two lists.
- Admin ratings are never changed.

One review flow (`apps/server/src/ai/review.ts`), set in the rating-helper card:

- **Move rated books out of the Inbox** (on by default): once Barnaby has rated a new book it's approved by itself,
  unless it looks like a copy of a book you have (same ISBN or title). Approval alone shows nothing to kids: an unrated
  book counts as adult. Turning it on, and every server start, files books he rated earlier.
- **Trust ratings Barnaby is sure about** (off by default): applies a looser rating (one that shows the book to
  kids) when he's at least the chosen confidence (80% default) and the book has no rating of its own. Folder, genre
  and admin ratings are never loosened. Off, his pick waits for one tap; **Accept Barnaby's picks** on Needs a rating
  does a page at once.
- The Inbox shows his rating and metadata fixes on each book, with filters (**Barnaby has a suggestion**, **Barnaby
  hasn't looked yet**), **Approve with Barnaby's picks** (his rating and fixes) and **Ask Barnaby** for selected books.

It runs on the job runner (`ai.rating`), one run at a time; the admin jobs page shows its log, and a run that a
restart interrupts carries on from the last book.

## Progress and cost (rating helper and metadata cleanup)

Each batch only takes books Barnaby hasn't looked at: the rating helper skips any book with a suggestion (waiting,
applied or dismissed), metadata cleanup skips any book it has checked. So the batches do end. Both cards show:

- **How far through the library** Barnaby is ("178 of 902 unrated books still to go"), and **All done** when nothing is left.
- **How many suggestions are waiting** for you, with a link down to the list.
- **Books that failed** (a garbled reply, a timeout). They're skipped by later batches so they can't clog the front of
  every run; **Try them again** runs just those.
- **Rate/Check the next 25**, or **all that's left in the background** (asks first when it costs money). **Stop**
  cancels a running batch; what it already did stays.
- **Estimated cost**: per book, for the next batch and for everything left, and what the tool has **spent so far**.
  Token counts come from the usage log (a first guess until a few books have run); prices are $ per million tokens
  from a built-in list (`packages/shared/src/ai-pricing.ts`) or the **Price** you type for a provider. A provider on a
  local address (Ollama, LM Studio, llama.cpp on `localhost`, a private IP or a Docker name like `ollama`) is free.
  These are estimates; your provider's bill is the real number.

## API

All routes need a signed-in reader. Admin routes use `requireAdmin`.

| Method | Path | What |
| --- | --- | --- |
| `GET` | `/api/ai/status` | `{ available, reason, message, kid, webSearch, bookChat, remainingToday }` |
| `POST` | `/api/ai/chat` | `{ message, conversationId?, bookId?, position?, webSearch? }` → `{ conversationId, message, reply: { content, sources }, remainingToday }`. Kids get 403 (`off`, `too_young`, `no_birth_year`) or 429 (`daily_limit`); 503 `not_configured` |
| `POST` | `/api/ai/chat/stream` | Same body. Server-sent events: `delta` `{ text }`, then `done` (the `/chat` body) or `error` `{ statusCode, code, message }`. Checks that fail before the model runs are plain JSON errors |
| `GET` | `/api/ai/books/:id/similar?limit=8` | More like this: `{ items: [BookSummary + reason, score] }`; 404 if the reader can't see the book |
| `GET` | `/api/ai/search?q&limit=12` | Meaning search: `{ available, items: [BookSummary + score] }` |
| `POST` | `/api/ai/smart-request` | `{ text, forKidId? }` → `{ interpreted: { like, age, topics, maxRating, forKid }, picks: [BookSummary + reason], outside: [{ title, author, reason }] }`. Grown-ups only |
| `GET` | `/api/ai/conversations?bookId` | My chats |
| `GET` | `/api/ai/conversations/:id` | One chat with messages (book sources re-checked against the content lock) |
| `DELETE` | `/api/ai/conversations/:id` | Grown-ups only; kids' chats are kept |
| `GET` | `/api/ai/kids` | Kids I manage, with settings, today's count and flagged chats |
| `GET`/`PUT` | `/api/ai/kids/:kidId/settings` | `{ enabled, webSearch, dailyLimit }`; PUT is linked parent or admin only |
| `GET` | `/api/ai/kids/:kidId/conversations[/:id]` | Parent log (linked parent or admin) |
| `GET`/`PUT` | `/api/admin/ai/settings` | Providers, features, search, moderation, kid defaults, `ratingHelper: { autoApprove, trustLooser, minConfidence }`. Omit `apiKey` to keep it, `""` to remove it |
| `POST` | `/api/admin/ai/providers/test` | `{ providerId, mode?: "auto" \| "chat" \| "embeddings" }` |
| `GET` | `/api/admin/ai/providers/:id/models` | Model list from the provider |
| `POST` | `/api/admin/ai/search/test` | `{ q, kid }` |
| `GET` | `/api/admin/ai/usage?days=30` | Calls, failures, tokens and average time per feature and model |
| `POST`/`GET` | `/api/admin/ai/rating/run` | Start (`{ limit, all?, retryFailed?, bookIds?, applyStricter }`, 202; 409 when nothing is left) / status of the rating helper, with `progress`, `estimate` and `spent` |
| `GET` | `/api/admin/ai/rating/suggestions?status=pending&scope=all` | Suggestions (`scope`: `all`, `inbox`, `library`) |
| `POST` | `/api/admin/ai/rating/suggestions/accept` | `{ bookIds }`: take Barnaby's pending ratings as admin ratings |
| `POST` | `/api/admin/ai/rating/suggestions/:bookId/accept` \| `/dismiss` | `{ rating? }` to accept a different rating |
| `GET` | `/api/admin/ai/embeddings` | `{ configured, model, indexed, total, job }` |
| `POST` | `/api/admin/ai/embeddings/run` | `{ bookIds? }`: index new and changed books (202) |
| `POST`/`GET` | `/api/admin/ai/metadata/run` | Start (`{ limit, all?, retryFailed?, bookIds? }`, 202; 409 when nothing is left) / status of metadata cleanup, with `progress`, `estimate` and `spent` |
| `GET` | `/api/admin/ai/metadata/suggestions?status=pending` | One row per book and field: `{ id, bookId, bookTitle, field, current, suggested, reason }` |
| `POST` | `/api/admin/ai/metadata/suggestions/:id/accept` \| `/dismiss` | `{ value? }` to accept an edited value |
| `POST` | `/api/admin/ai/metadata/suggestions/accept` | `{ bookIds }`: every pending fix for these books |
| `GET` | `/api/admin/inbox?filter=all\|suggested\|unseen` | Each item has `barnaby: { rating, fixes }`; `counts` per filter |
| `POST` | `/api/admin/inbox/approve` | `{ ids, rating?, barnabyRating?, barnabyFixes? }` |
| `GET` | `/api/admin/review/unrated` | Unrated books plus books with a looser Barnaby rating waiting; `barnaby: { rating }` |

Tables (`apps/server/src/ai/schema.ts`): `ai_conversations`, `ai_message_sources`, `ai_kid_settings`, `ai_usage`,
`ai_rating_suggestions`, `ai_book_embeddings`, `ai_metadata_suggestions`, `ai_metadata_checks`; messages are in
`ai_messages`. Jobs: `ai.rating`, `ai.metadata`, `ai.embed`.

## Not done yet

Voice (Piper/Kokoro TTS, Whisper) and quizzes (`ws/readaloud`). Smart requests for kids (they use the chat). Meaning
search compares vectors in memory, which is fine for a family library (tens of thousands of books); a vector index
(sqlite-vec) would be the next step past that.
