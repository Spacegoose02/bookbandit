# Discover changes (`ws/discover`)


- 2026-11-14: "Request it" on Discover understands `409 already_in_library` from `POST /api/requests` and links to the book instead of showing an error (this PR)
- 2026-11-14: Discover (Open Library and Hardcover trending with In library / On Kindle / Request it badges, Popular in your family), series pages in reading order with admin create/rename/drag-to-reorder, category browsing, Cook mode for cookbooks, Kindle library CSV import as metadata-only books. All through the content lock; kids only see outside books already on their shelf. API: [discover-api.md](../discover-api.md) (#16)
