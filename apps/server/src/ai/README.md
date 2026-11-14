# Barnaby AI (server)

Setup, kid-mode rules and the API are in [docs/ai.md](../../../../docs/ai.md).

- `providers/`: OpenAI-compatible, Anthropic and Gemini clients behind one `chat()` shape.
- `chat.ts`: one chat turn (checks, moderation, library/web/book context, model call, log).
- `library-context.ts`: the only way books reach a prompt; starts from `visibleBooksWhere`.
- `kids.ts`, `moderation.ts`, `privacy.ts`: kid rules.
- `rating.ts`: rating helper (can lock a book, never unlock one).
- `providers/`: also `chatStream()` (server-sent events) and `embed()` for meaning search (Claude has none).
- `embeddings.ts`: book vectors (`ai_book_embeddings`), meaning search, nearest books.
- `recommend.ts`: "more like this" (series/author/genre overlap + embeddings) and shared book-list helpers.
- `smart-request.ts`: "something like X for a 10-year-old" (grown-ups; age cap and a kid's own lock).
- `metadata.ts`: metadata cleanup suggestions, applied one field at a time by an admin.
- `jobs.ts`: `ai.rating`, `ai.metadata`, `ai.embed` on the shared job runner.
