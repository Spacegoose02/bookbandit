# Admin and family UI changes (`ws/admin`)

- 2026-11-14: Family dashboard shows reading time from `GET /api/reading/stats`: minutes per day for the last 7 days (reading and listening), streak, daily average and the books with the most time; each kid card shows minutes this week (this PR)
- 2026-11-14: Admin and family UI: `/admin` (overview + scan, inbox with bulk approve, rating, metadata edit, merge, reject; needs-a-rating queue; people, kids and paired devices; Audiobookshelf, SMTP and metadata-lookup settings) and `/family` (per-kid reading, requests and read-only Barnaby chats). New APIs in `routes/admin-library.ts`, `admin-settings.ts`, `admin-family.ts`; see [admin-api.md](../admin-api.md). Metadata API keys can be set in the browser and apply without a restart (#15)
