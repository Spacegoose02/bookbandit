# Feature gaps and phone check (2026-11-14)

Where BookBandit stands against the leading reading apps (Kindle, Apple Books, Kobo, Moon+ Reader,
KOReader, Readest, Calibre-Web, Kavita, Komga, StoryGraph, Goodreads), and how the web reader holds
up on phones. Every "missing" item below was checked against the code on `main`, not guessed.

## What we already match or beat

Multi-format reader (EPUB, AZW3/MOBI, FB2, CBZ, PDF), themes including high contrast and a
dyslexia font, cross-device progress sync, bookmarks, OPDS + KOReader + Kobo sync, Send to Kindle,
audiobooks (own player and Audiobookshelf), read-along (EPUB3 media overlays), neural read-aloud
with word highlighting, word help, Barnaby AI (ask your library, spoiler-free chat, more like this,
meaning search), Goodreads/StoryGraph/Calibre/Kavita import, series, Discover, requests, family
accounts with a server-side content lock, goals, badges, bedtime, storyteller mode, backups.
No other app on the list has the family and kids side.

## Gaps

### Must-have (readers notice these in the first week)

1. **Highlights and notes in the reader.** The sync API already stores highlights
   (`kind: "highlight"`, colour, note), but the web reader has no text-selection menu to make one,
   and no list to read them back. Every competitor has this.
2. **Search inside the book.** No in-book search at all. foliate-js has `view.search()`, so this is
   mostly UI.
3. **Want to read and personal shelves.** Goodreads/StoryGraph "Want to read" lists are parsed on
   import but there is nowhere to keep them, and a reader can't make their own shelf or collection.
4. **Time left in chapter / book.** The footer shows `loc 1 of 6`, which means nothing to a reader.
   Kindle, Kobo, Apple Books and Moon+ all show minutes left, worked out from reading speed.
5. **Footnote pop-ups.** `readerCss.ts` hides EPUB footnote asides, and tapping a note reference
   jumps away instead of showing a pop-up.
6. **Layout controls.** Font size, font, line spacing and scroll mode exist; margins, justification,
   hyphenation, paragraph spacing and one/two-column choice don't.
7. **Phones** (see below): the reader was unusable under 475px wide (fixed in this PR), and the
   web app has no service worker, so a phone browser can't read offline.

### Nice to have

- Grown-up reading stats: time read, books per year, streaks, year in review (kids have goals and
  badges; adults have nothing). StoryGraph's charts are its main draw.
- Personal star ratings and short reviews, shown to the family.
- Export highlights to Markdown, Readwise or Obsidian (after highlights exist).
- Comics: CBR/CB7 in the reader (the server already knows `cbr`), right-to-left manga, two-page
  spreads, pinch-zoom and panel view (Kavita/Komga territory).
- Reader settings that follow the person across devices (they are per device today, on purpose;
  make it an opt-in).
- Android app: volume keys turn pages, keep screen on while reading, brightness/warmth slider.
- Notifications: a request was approved, the next book in a series arrived.
- Translations of the app (no i18n today).
- Browse outside OPDS catalogs (Project Gutenberg, Standard Ebooks) and request from them.

### Differentiators (things the big apps can't or won't do for a family)

- **Switch between listening and reading at the same spot** (Whispersync for your own files).
  We already have the ebook, the audiobook and read-along alignment; matching positions across
  the two is the missing step.
- **Barnaby "story so far" and character list**, spoiler-free up to the reader's position
  (Kindle X-Ray, but for any book and on your own server). The spoiler-free chat is the base.
- **Family book club**: two people read the same book and leave notes in the margin for each
  other, parents can read along with a kid's highlights, Barnaby asks discussion questions.
- **Kid reading level**: suggest books one step up from what a kid finishes, using the age
  ratings and quiz results we already collect.

## Phones

Run in Chromium at 375×812 and 412×915 with touch on, demo build, kid and grown-up.

### Fixed in this PR

- **The reader was 475px wide on any screen narrower than that.** The reader's grid column took
  the book view's min-content width, so on every phone the right edge of the text, the
  next-page tap zone, the bookmarks list button, the Aa (text and colours) button and the
  percentage were off screen. Swiping still turned pages, but text settings were unreachable.
  One CSS line (`grid-template-columns: minmax(0, 1fr)` on `.bb-reader`) fixes it at every width;
  tablets and desktops are unchanged.
  Before: `screenshots/2026-11-14-web-phone-reader-before.png`, after: `2026-11-14-web-phone-reader.png`.

### Still open, in priority order

1. **Floating buttons cover the page.** The Read-aloud pill and Barnaby button sit on top of the
   last lines of text and, in the kid reader, on top of the round next-page button and the
   progress bar (`2026-11-14-web-phone-kid-reader.png`). On phones they should live in the
   toolbar or move above the footer.
2. **Toolbars never hide on their own.** Header and footer take about 200px of an 812px screen,
   and the only way to hide them is a hidden 40px strip at the bottom centre. A tap in the middle
   of the page should toggle them, as in every other reader. In landscape the bars take 37% of the
   height (`2026-11-14-web-phone-reader-landscape.png`).
3. **Top navigation wraps to three rows and is sticky**: 219px of a 812px screen stays pinned
   while scrolling the library (`2026-11-14-web-phone-library-scrolled.png`). Phones want a
   bottom tab bar with four items and the rest in a menu. (Home and Discover are being
   redesigned in another thread; this is the shared nav.)
4. **No offline on a phone browser and no install prompt help.** There is a manifest but no
   service worker, so a phone that installs the PWA still needs the server for every page and
   book. Offline exists only in the Android and Windows apps.
5. **Side margins are fixed** (`gap 6%` in `ReaderPage.tsx`). Fine on a phone, but readers can't widen
   or narrow them.
6. **Word help on grown-up phones** opens on double-click; on touch screens that's a double-tap,
   which some browsers treat as zoom. Long-press would be safer.

What works well on phones: library grid (two columns, no sideways scroll), swiping between
pages, safe-area padding on the reader bars, big kid tap targets, and the settings panel goes
full width.

### Android app on phones

The app isn't locked to tablets: the manifest has no `screenOrientation` or `supports-screens`
limit, so it installs and runs on phones. It wraps the same web app, so everything above applies
to it too (the reader fix included). The README and roadmap only promise tablets, and nobody has
tried it on a phone yet; it should be added to the owner device checks.
