# Barnaby, the AI helper

Barnaby the raccoon is BookBandit's face and its optional AI helper. He can:

- **Chat with grown-ups** about the family library: recommendations from books you actually have, questions,
  and web answers with numbered sources.
- **Chat with kids** at their age level, only about books they're allowed to see, with moderation, a daily
  limit and a log their parents can read.
- **Talk about the book you're reading without spoilers**: he only gets the text up to your position.
- **Suggest ratings for unrated books** (the rating helper) for the admin review queue.

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
5. Turn Barnaby on for each kid at **Barnaby → Kids' Barnaby chats** (`/barnaby/family`).

The floating Barnaby button now appears on every page. In the reader or on a book page he chats about that book.

## Providers

Every feature (grown-up chat, kid chat, book chat, moderation, rating helper) can use a different provider.
Kid chat and book chat use the grown-up chat provider unless you set them. API keys are encrypted in the
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

**Load models** lists what the provider offers. **Test** sends "say hello" and shows the answer and time.

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

## Rating helper

At the bottom of Barnaby settings, **Rate 25 unrated books** asks the rating-helper provider to rate books that
have no rating yet, from the title, authors, genres, description, folder and the opening of the text. It's
fail-closed:

- A suggestion **stricter** than the current rating (unrated counts as adult) is applied at once, as an `ai`
  rating. It can only hide a book from kids, never show one.
- Anything else waits in the list for an admin to **Accept** (stored as an admin rating) or **Dismiss**.
- Admin ratings are never changed.

## API

All routes need a signed-in reader. Admin routes use `requireAdmin`.

| Method | Path | What |
| --- | --- | --- |
| `GET` | `/api/ai/status` | `{ available, reason, message, kid, webSearch, bookChat, remainingToday }` |
| `POST` | `/api/ai/chat` | `{ message, conversationId?, bookId?, position?, webSearch? }` → `{ conversationId, message, reply: { content, sources }, remainingToday }`. Kids get 403 (`off`, `too_young`, `no_birth_year`) or 429 (`daily_limit`); 503 `not_configured` |
| `GET` | `/api/ai/conversations?bookId` | My chats |
| `GET` | `/api/ai/conversations/:id` | One chat with messages (book sources re-checked against the content lock) |
| `DELETE` | `/api/ai/conversations/:id` | Grown-ups only; kids' chats are kept |
| `GET` | `/api/ai/kids` | Kids I manage, with settings, today's count and flagged chats |
| `GET`/`PUT` | `/api/ai/kids/:kidId/settings` | `{ enabled, webSearch, dailyLimit }`; PUT is linked parent or admin only |
| `GET` | `/api/ai/kids/:kidId/conversations[/:id]` | Parent log (linked parent or admin) |
| `GET`/`PUT` | `/api/admin/ai/settings` | Providers, features, search, moderation, kid defaults. Omit `apiKey` to keep it, `""` to remove it |
| `POST` | `/api/admin/ai/providers/test` | `{ providerId }` |
| `GET` | `/api/admin/ai/providers/:id/models` | Model list from the provider |
| `POST` | `/api/admin/ai/search/test` | `{ q, kid }` |
| `GET` | `/api/admin/ai/usage?days=30` | Calls, failures, tokens and average time per feature and model |
| `POST`/`GET` | `/api/admin/ai/rating/run` | Start (`{ limit, bookIds?, applyStricter }`, 202) / status of the rating helper |
| `GET` | `/api/admin/ai/rating/suggestions?status=pending` | Review queue |
| `POST` | `/api/admin/ai/rating/suggestions/:bookId/accept` \| `/dismiss` | `{ rating? }` to accept a different rating |

Tables (`apps/server/src/ai/schema.ts`): `ai_conversations`, `ai_message_sources`, `ai_kid_settings`, `ai_usage`,
`ai_rating_suggestions`; messages are in `ai_messages`.

## Not done yet

Streaming replies, "more like this", smart requests, metadata cleanup, meaning search with embeddings, voice
(Piper/Kokoro TTS, Whisper) and quizzes. The rating helper runs inline until the job runner (`ws/requests`) lands
(`TODO(jobs)` in `apps/server/src/ai/rating.ts`).
