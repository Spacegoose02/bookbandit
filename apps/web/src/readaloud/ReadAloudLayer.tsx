/**
 * Read-aloud in the reader: the "Read to me" button and player bar, tap-a-word help, and the
 * after-chapter quiz for kids. The reader mounts this with one line (ReaderPage.tsx); everything
 * else lives in this folder.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { FoliateLocation, FoliateView } from "foliate-js/view.js";
import { useSession } from "../app/session";
import { readAloudApi, type NarrationStatus, type QuizView } from "./api";
import { browserVoiceAvailable, Narrator, sectionIndex, type NarratedView, type NarrationMode, type NarratorState } from "./narrator";
import { QuizDialog } from "./QuizDialog";
import { sentenceAround, wordAround } from "./ssml";
import { VoicePicker } from "./VoicePicker";
import { WordCard } from "./WordCard";
import "./readaloud.css";

/** A kid has to stay in a chapter this long before finishing it counts (skips covers and title pages). */
const QUIZ_MIN_SECONDS = 45;

const HIGHLIGHT_CSS = `
::selection { background: rgba(255, 196, 0, 0.55); color: inherit; }
.-epub-media-overlay-active, .bb-ra-active { background: rgba(255, 196, 0, 0.55); border-radius: 3px; }
`;

interface Props {
  bookId: string;
  viewRef: RefObject<FoliateView | null>;
  /** The book is open in foliate-js (not a PDF). */
  ready: boolean;
}

interface WordTap {
  word: string;
  context: string;
  x: number;
  y: number;
}

export function ReadAloudLayer({ bookId, viewRef, ready }: Props) {
  const { me } = useSession();
  const kid = !!me?.isKid;
  const [status, setStatus] = useState<NarrationStatus | null>(null);
  const [mode, setMode] = useState<NarrationMode | null>(null);
  const [state, setState] = useState<NarratorState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [tap, setTap] = useState<WordTap | null>(null);
  const [quizOffer, setQuizOffer] = useState<QuizView | null>(null);
  const [quiz, setQuiz] = useState<QuizView | null>(null);
  const narrator = useRef<Narrator | null>(null);
  const [rate, setRate] = useState(1);

  // What can speak in this book?
  useEffect(() => {
    if (!ready) return;
    let gone = false;
    readAloudApi
      .status(bookId)
      .catch(() => null)
      .then((s) => {
        if (gone) return;
        setStatus(s);
        const view = viewRef.current as NarratedView | null;
        if (s?.mediaOverlay && view?.mediaOverlay) setMode("overlay");
        else if (s?.server) setMode("server");
        else if (browserVoiceAvailable()) setMode("browser");
        else setMode(null);
      });
    return () => {
      gone = true;
    };
  }, [bookId, ready, viewRef]);

  useEffect(() => () => narrator.current?.stop(), []);

  const stop = useCallback(() => {
    narrator.current?.stop();
    narrator.current = null;
    setState("idle");
  }, []);

  const play = useCallback(() => {
    const view = viewRef.current as NarratedView | null;
    if (!view || !mode) return;
    if (narrator.current) {
      if (narrator.current.isPaused) narrator.current.resume();
      else narrator.current.pause();
      return;
    }
    setError(null);
    setTap(null);
    const n = new Narrator(view, {
      bookId,
      mode,
      rate,
      lang: (view.book as { metadata?: { language?: string | string[] } } | null)?.metadata?.language?.toString() ?? "en",
      onState: (s, detail) => {
        setState(s);
        if (s === "error") {
          setError(detail ?? "Read-aloud stopped");
          narrator.current = null;
          if (mode === "server" && browserVoiceAvailable()) setMode("browser");
        }
        if (s === "ended") narrator.current = null;
      },
    });
    narrator.current = n;
    n.start();
  }, [bookId, mode, rate, viewRef]);

  // --- highlight style, tap-a-word, chapter tracking ---------------------------
  const kidRef = useRef(kid);
  kidRef.current = kid;
  useEffect(() => {
    if (!ready) return;
    const view = viewRef.current as NarratedView | null;
    if (!view) return;
    const seen = new WeakSet<Document>();

    const onWord = (doc: Document) => (e: MouseEvent) => {
      if (e.type === "click" && !kidRef.current) return; // grown-ups double-click
      const sel = doc.getSelection();
      if (e.type === "click" && sel && !sel.isCollapsed) return; // they're selecting text
      const hit = caretAt(doc, e.clientX, e.clientY);
      if (!hit) return;
      const text = hit.node.textContent ?? "";
      const w = wordAround(text, hit.offset);
      if (!w) return;
      const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
      setTap({ word: w.word, context: sentenceAround(text, w.start, w.end), x: (frame?.left ?? 0) + e.clientX, y: (frame?.top ?? 0) + e.clientY });
    };

    const prepare = (doc: Document) => {
      if (seen.has(doc)) return;
      seen.add(doc);
      const style = doc.createElement("style");
      style.textContent = HIGHLIGHT_CSS;
      doc.head?.append(style);
      doc.addEventListener("click", onWord(doc));
      doc.addEventListener("dblclick", onWord(doc));
    };
    for (const c of view.renderer.getContents?.() ?? []) prepare(c.doc);
    const onLoad = (e: Event) => prepare((e as CustomEvent<{ doc: Document }>).detail.doc);
    view.addEventListener("load", onLoad);

    // Chapter finished? (kids only) Moving forward into the next section after real reading time.
    let current = sectionIndex(view);
    let enteredAt = Date.now();
    let label: string | null = view.lastLocation?.tocItem?.label ?? null;
    const onRelocate = (e: Event) => {
      const loc = (e as CustomEvent<FoliateLocation>).detail;
      const idx = loc.section?.current ?? sectionIndex(view);
      if (idx == null) return;
      if (current != null && idx === current + 1 && kidRef.current && Date.now() - enteredAt > QUIZ_MIN_SECONDS * 1000) {
        const section = view.book?.sections?.[current]?.id;
        if (section) offerQuiz(section, label);
      }
      if (idx !== current) {
        current = idx;
        enteredAt = Date.now();
      }
      label = loc.tocItem?.label ?? label;
    };
    view.addEventListener("relocate", onRelocate);
    return () => {
      view.removeEventListener("load", onLoad);
      view.removeEventListener("relocate", onRelocate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, viewRef, bookId]);

  const offerQuiz = (section: string, label: string | null) => {
    readAloudApi
      .quiz(bookId, section, label)
      .then((q) => {
        if (q.completedAt == null) setQuizOffer(q);
      })
      .catch(() => undefined); // too short, not an EPUB: no quiz, no fuss
  };

  const quizMeNow = () => {
    const view = viewRef.current as NarratedView | null;
    const idx = view ? sectionIndex(view) : null;
    const section = idx != null ? view?.book?.sections?.[idx]?.id : undefined;
    if (!section) return;
    narrator.current?.pause();
    readAloudApi
      .quiz(bookId, section, view?.lastLocation?.tocItem?.label ?? null)
      .then(setQuiz)
      .catch((e: Error) => setError(e.message.includes("short") ? "This part is too short for a quiz. Keep reading!" : e.message));
  };

  if (!ready || !mode) return quiz ? <QuizDialog quiz={quiz} kid={kid} server={!!status?.server} onClose={() => setQuiz(null)} /> : null;

  const active = state !== "idle" && state !== "ended";
  const playing = state === "playing" || state === "loading";
  const voiceLabel =
    mode === "overlay" ? "The book's narrator" : mode === "server" ? (status?.voice ?? "Voice") : "This device's voice";

  return (
    <>
      {!active && (
        <button className={`bb-ra-fab${kid ? " is-kid" : ""}`} onClick={play} aria-label="Read to me">
          <span aria-hidden>🔊</span> {kid ? "Read to me" : "Read aloud"}
        </button>
      )}
      {active && (
        <div className={`bb-ra-bar${kid ? " is-kid" : ""}`} role="region" aria-label="Read aloud">
          <button className="bb-ra-btn is-main" onClick={play} aria-label={playing ? "Pause" : "Play"}>
            {state === "loading" ? <span className="bb-ra-spin" aria-hidden /> : playing ? "⏸" : "▶"}
          </button>
          <button className="bb-ra-btn" onClick={stop} aria-label="Stop reading">
            ⏹
          </button>
          <span className="bb-ra-voice" title={voiceLabel}>
            {mode === "overlay" ? "🎙️ " : "🗣️ "}
            {voiceLabel}
          </span>
          {mode !== "server" && (
            <select
              className="bb-ra-rate"
              aria-label="Reading speed"
              value={rate}
              onChange={(e) => {
                setRate(Number(e.target.value));
                stop();
              }}
            >
              {[0.75, 0.9, 1, 1.15, 1.3].map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          )}
          {mode === "server" && (
            <button className="bb-ra-btn" onClick={() => setPicker(true)} aria-label="Pick a voice">
              ⚙
            </button>
          )}
          {kid && (
            <button className="bb-ra-btn" onClick={quizMeNow} aria-label="Quiz me on this chapter">
              ❓
            </button>
          )}
        </div>
      )}
      {error && (
        <div className="bb-ra-error" role="status" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {picker && me && (
        <VoicePicker
          userId={me.id}
          kid={kid}
          onClose={(changed) => {
            setPicker(false);
            if (changed) {
              stop();
              readAloudApi.status(bookId).then(setStatus, () => undefined);
            }
          }}
        />
      )}
      {tap && <WordCard {...tap} bookId={bookId} kid={kid} server={!!status?.server} onClose={() => setTap(null)} />}
      {quizOffer && !quiz && (
        <div className={`bb-ra-offer${kid ? " is-kid" : ""}`} role="dialog" aria-label="Quiz time">
          <img src={`${import.meta.env.BASE_URL}brand/barnaby-face.webp`} alt="" width={56} height={56} />
          <div>
            <strong>You finished {quizOffer.chapterLabel ? `“${quizOffer.chapterLabel}”` : "a chapter"}!</strong>
            <span>Want to try Barnaby's quiz?</span>
          </div>
          <button
            className="bb-btn bb-btn-primary"
            onClick={() => {
              narrator.current?.pause();
              setQuiz(quizOffer);
              setQuizOffer(null);
            }}
          >
            Let's go!
          </button>
          <button className="bb-btn bb-btn-ghost" onClick={() => setQuizOffer(null)}>
            Not now
          </button>
        </div>
      )}
      {quiz && <QuizDialog quiz={quiz} kid={kid} server={!!status?.server} onClose={() => setQuiz(null)} />}
    </>
  );
}

/** The text node and offset under a point, in WebKit/Blink and Firefox. */
function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (p && p.offsetNode.nodeType === 3) return { node: p.offsetNode, offset: p.offset };
  }
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    if (r && r.startContainer.nodeType === 3) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}
