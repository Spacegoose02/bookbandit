/** Family dashboard card: a kid's quizzes and the words they looked up. Read-only. */
import { useState } from "react";
import { Card, ErrorNote, timeAgo, useLoad } from "../admin/ui";
import { readAloudApi } from "./api";
import { VoicePicker } from "./VoicePicker";
import "./readaloud.css";

export function LearningCard({ kidId, kidName }: { kidId: string; kidName: string }) {
  const data = useLoad(() => readAloudApi.kidSummary(kidId), [kidId]);
  const [voice, setVoice] = useState(false);
  const d = data.data;
  return (
    <Card
      title="Quizzes and words"
      className="bb-ra-learning"
      actions={
        <button className="bb-btn bb-btn-ghost" onClick={() => setVoice(true)}>
          🗣️ Reading voice
        </button>
      }
    >
      <ErrorNote error={data.error} />
      {!d && !data.error && <p className="bb-muted">Loading…</p>}
      {d && (
        <>
          <dl className="bb-ra-stats">
            <div>
              <dt>Quizzes</dt>
              <dd>{d.stats.quizzes}</dd>
            </div>
            <div>
              <dt>Right answers</dt>
              <dd>{d.stats.questions ? `${Math.round((d.stats.correct / d.stats.questions) * 100)}%` : "–"}</dd>
            </div>
            <div>
              <dt>Words looked up</dt>
              <dd>{d.stats.words}</dd>
            </div>
          </dl>
          <p className="bb-muted bb-small">Last {d.days} days. Barnaby offers a three-question quiz when {kidName} finishes a chapter.</p>
          {d.quizzes.length === 0 ? (
            <p className="bb-muted">No quizzes yet.</p>
          ) : (
            <ul className="bb-ra-quizlog">
              {d.quizzes.map((q) => (
                <li key={q.id}>
                  <details>
                    <summary>
                      <span className="bb-ra-score" data-perfect={q.score === q.questions.length || undefined}>
                        {q.completedAt ? `${q.score}/${q.questions.length}` : "…"}
                      </span>
                      <span className="bb-person-main">
                        <strong>{q.bookTitle}</strong>
                        <span className="bb-muted bb-small">
                          {" "}
                          · {q.chapterLabel ?? "a chapter"} · {timeAgo(q.completedAt ?? q.createdAt)}
                          {q.source === "ai" ? " · by Barnaby" : ""}
                        </span>
                      </span>
                    </summary>
                    <ol>
                      {q.questions.map((x, i) => (
                        <li key={i}>
                          {x.q}{" "}
                          {x.picked == null ? (
                            <span className="bb-muted">(not answered)</span>
                          ) : x.picked === x.answer ? (
                            <span className="bb-ra-ok">✓ {x.choices[x.picked]}</span>
                          ) : (
                            <span className="bb-ra-no">
                              ✗ {x.choices[x.picked]} <span className="bb-muted">(answer: {x.answer != null ? x.choices[x.answer] : "?"})</span>
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                </li>
              ))}
            </ul>
          )}
          {d.words.length > 0 && (
            <>
              <h3 className="bb-subhead">Words {kidName} tapped</h3>
              <ul className="bb-ra-words">
                {d.words.map((w) => (
                  <li key={w.word} title={w.bookTitle ? `In ${w.bookTitle}` : undefined} className={w.found ? "" : "is-missing"}>
                    {w.word}
                    {w.times > 1 ? <small> ×{w.times}</small> : null}
                  </li>
                ))}
              </ul>
              {d.words.some((w) => !w.found) && <p className="bb-muted bb-small">Dashed words had no meaning yet. You can explain them, or turn on Barnaby for {kidName}.</p>}
            </>
          )}
        </>
      )}
      {voice && <VoicePicker userId={kidId} kid={false} onClose={() => setVoice(false)} />}
    </Card>
  );
}
