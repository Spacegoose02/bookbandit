# Barnaby AI (server)

Setup, kid-mode rules and the API are in [docs/ai.md](../../../../docs/ai.md).

- `providers/`: OpenAI-compatible, Anthropic and Gemini clients behind one `chat()` shape.
- `chat.ts`: one chat turn (checks, moderation, library/web/book context, model call, log).
- `library-context.ts`: the only way books reach a prompt; starts from `visibleBooksWhere`.
- `kids.ts`, `moderation.ts`, `privacy.ts`: kid rules.
- `rating.ts`: rating helper (can lock a book, never unlock one).
