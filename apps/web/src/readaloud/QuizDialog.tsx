/** Barnaby's three-question quiz after a chapter. One answer at a time, with a cheer for each. */
import { useState } from "react";
import { BarnabyAvatar } from "../brand/Barnaby";
import { readAloudApi, type AnswerResult, type QuizView } from "./api";
import { sayWord } from "./narrator";

export function QuizDialog({ quiz, kid, server, onClose }: { quiz: QuizView; kid: boolean; server: boolean; onClose(): void }) {
  const firstOpen = quiz.questions.findIndex((q) => q.picked == null);
  const [i, setI] = useState(firstOpen < 0 ? quiz.questions.length - 1 : firstOpen);
  const [results, setResults] = useState<Record<number, AnswerResult>>({});
  const [busy, setBusy] = useState(false);
  const [final, setFinal] = useState<string | null>(quiz.completedAt ? `${quiz.score ?? 0} out of ${quiz.questions.length}!` : null);
  const q = quiz.questions[i]!;
  const r = results[i];
  const picked = r ? (quiz.questions[i]!.picked ?? null) : q.picked;
  const answer = r?.answer ?? q.answer;

  const pick = async (choice: number) => {
    if (busy || picked != null) return;
    setBusy(true);
    try {
      const res = await readAloudApi.answer(quiz.id, i, choice);
      quiz.questions[i] = { ...q, picked: choice, answer: res.answer };
      setResults((x) => ({ ...x, [i]: res }));
      if (kid) void sayWord(res.cheer.replace(/[^\p{L}\p{N}\s!,.'?]/gu, ""), { bookId: quiz.bookId, server });
      if (res.done) setFinal(res.finalCheer);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bb-ra-modal" role="dialog" aria-modal="true" aria-label="Barnaby's quiz">
      <div className={`bb-ra-quiz${kid ? " is-kid" : ""}`}>
        <header>
          <BarnabyAvatar size={kid ? 64 : 48} />
          <div>
            <h2>Barnaby's quiz</h2>
            {quiz.chapterLabel && <p className="bb-muted">{quiz.chapterLabel}</p>}
          </div>
          <button className="bb-icon-btn" onClick={onClose} aria-label="Close quiz">
            ✕
          </button>
        </header>
        <ol className="bb-ra-dots" aria-label={`Question ${i + 1} of ${quiz.questions.length}`}>
          {quiz.questions.map((x, n) => (
            <li key={n} className={n === i ? "is-now" : x.picked == null ? "" : x.picked === x.answer ? "is-right" : "is-wrong"} />
          ))}
        </ol>
        <div className="bb-ra-q">
          <p>{q.q}</p>
          <button className="bb-icon-btn" onClick={() => void sayWord(`${q.q} ${q.choices.join(". ")}`, { bookId: quiz.bookId, server })} aria-label="Read the question to me">
            🔊
          </button>
        </div>
        <div className="bb-ra-choices">
          {q.choices.map((c, n) => {
            const cls = picked == null ? "" : n === answer ? " is-right" : n === picked ? " is-wrong" : " is-dim";
            return (
              <button key={n} className={`bb-ra-choice${cls}`} onClick={() => void pick(n)} disabled={busy || picked != null}>
                <span className="bb-ra-letter">{"ABCD"[n]}</span> {c}
              </button>
            );
          })}
        </div>
        {r && <p className={`bb-ra-cheer${r.correct ? " is-right" : ""}`}>{r.cheer}</p>}
        <footer>
          {picked != null && i < quiz.questions.length - 1 && (
            <button className="bb-btn bb-btn-primary bb-btn-big" onClick={() => setI(i + 1)}>
              Next question →
            </button>
          )}
          {final && i === quiz.questions.length - 1 && picked != null && (
            <>
              <p className="bb-ra-final">{final}</p>
              <button className="bb-btn bb-btn-primary bb-btn-big" onClick={onClose}>
                Back to the book 📖
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
