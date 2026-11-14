# Barnaby AI (`ws/ai`) change log

- 2026-11-14: Claude provider no longer sends `temperature`, which current Claude models (e.g. `claude-opus-5-5`) reject with HTTP 400 (this PR)
- 2026-11-14: Barnaby AI and Barnaby chats tabs in the Admin and Family areas, so the settings and the kids' chat log are reachable from the menus (#29)
- 2026-11-14: Barnaby AI. Providers (Ollama/LM Studio/llama.cpp/OpenAI-compatible, Anthropic, Gemini) chosen per feature, SearXNG web search with sources, moderation (word filter + Llama Guard or any model), grown-up chat, kid mode (parent switch, no chat under 5, daily limit, content lock, personal details removed, parent log), spoiler-free book chat, rating helper, usage log. Web: floating Barnaby button, `/barnaby`, `/barnaby/family`, `/barnaby/settings`. Setup: [ai.md](../ai.md) (#22)
