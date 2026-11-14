# Word help and quizzes

Owned by `ws/readaloud`; web side in `apps/web/src/readaloud/`.

## Word help

Kids tap a word in the reader (grown-ups double-click) and get a short meaning, the word split
into chunks (`light·house`), and **Say it** / **Slowly** buttons. `GET /api/learning/words/:word?bookId=&context=`
answers from, in order:

1. **The family's word list** (`learning_words`): meanings a parent wrote, plus Barnaby's earlier
   answers. Parents manage it with `GET /api/learning/words`, `PUT`/`DELETE /api/learning/words/:word`.
2. **An offline dictionary.** A built-in list of ~200 words that trip up young readers
   (`kid-words.ts`), plus an optional bigger file the admin drops at `CONFIG_DIR/dictionary.json`:
   `{"word": "meaning"}` or `{"word": {"meaning": "...", "example": "..."}}`. Plurals and
   `-ed`/`-ing`/`-ly` forms are looked up by their base word.
3. **Barnaby (AI)**, only when an AI provider is set up (`docs/ai.md`) and, for kids, a parent has
   turned Barnaby on for them and they're 5 or older. The kid chat provider writes a meaning for
   the word in its sentence; the moderation model checks it; the answer is saved to the family's
   word list so it's asked once per household.

Every lookup is logged (`learning_lookups`) for the family dashboard.

## Quizzes

When a kid moves on from a chapter they spent real time in (45 s or more), the reader asks
`POST /api/learning/quizzes {bookId, section, chapterLabel}` and, if a quiz comes back, Barnaby
offers it. Kids can also press ❓ in the read-aloud bar. The server reads that spine item's text
from the EPUB itself (only spine items can be read; locked books 404) and makes three questions:

- **With Barnaby on for the kid:** the kid chat provider writes three multiple-choice questions
  from the chapter text, as JSON; the reply is checked for shape and moderated, and falls back to
  offline questions if anything is off.
- **Offline:** "Who was in this part of the story?" (the most frequent name, with made-up decoys)
  and fill-in-the-missing-word questions from sentences spread through the chapter.

Answers go one at a time (`POST /api/learning/quizzes/:id/answer {question, choice}`) so Barnaby can
cheer right away; the first pick counts. The same chapter on the same day reopens the same quiz.

Kids' AI use for word help and quizzes has its own cap (40 a day) and doesn't use up their chat limit.

## Parents

`GET /api/learning/kids/:kidId` (linked parent, admin, or the kid themselves) returns the last 30
days of quizzes with every question and answer, and the words the kid tapped. Book titles are
filtered through the viewer's content lock. Shown on the family page as **Quizzes and words**.

Tables (this folder's `schema.ts`, migration `0013_readaloud`): `learning_words`, `learning_lookups`,
`learning_quizzes`.
