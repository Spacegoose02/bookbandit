import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { BookSummary } from "../api/types";
import { BarnabyAvatar } from "../brand/Barnaby";
import { Cover } from "../library/BookCard";

/**
 * "Pick a book for me": Barnaby shuffles the covers for a moment and lands on one. Only books the
 * kid's shelves already returned (so the server's content lock has already applied), preferring
 * ones they haven't finished. No streaks, timers or "spin again to win": it's just help choosing.
 */
export function BookSpinner({ books, linkFor }: { books: BookSummary[]; linkFor: (b: BookSummary) => string }) {
  const [open, setOpen] = useState(false);
  const pool = choosable(books);
  if (pool.length < 2) return null;
  return (
    <>
      <button type="button" className="bb-btn bb-btn-big bb-spin-open" onClick={() => setOpen(true)}>
        <span aria-hidden>🎲</span> Pick a book for me
      </button>
      {open && <SpinnerDialog pool={pool} linkFor={linkFor} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Unfinished books first; if everything is finished, any book will do. */
export function choosable(books: BookSummary[]): BookSummary[] {
  const unfinished = books.filter((b) => !b.kindleOnly && (b.percent ?? 0) < 0.98);
  return unfinished.length >= 2 ? unfinished : books.filter((b) => !b.kindleOnly);
}

/** The delays between shuffles: quick at first, slowing down to a stop (about two seconds). */
export function shuffleDelays(steps = 14): number[] {
  return Array.from({ length: steps }, (_, i) => Math.round(60 + 240 * (i / (steps - 1)) ** 2));
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function SpinnerDialog({ pool, linkFor, onClose }: { pool: BookSummary[]; linkFor: (b: BookSummary) => string; onClose: () => void }) {
  const [shown, setShown] = useState(0);
  const [done, setDone] = useState(false);
  const [round, setRound] = useState(0);
  const timers = useRef<number[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setDone(false);
    const final = Math.floor(Math.random() * pool.length);
    if (reducedMotion()) {
      setShown(final);
      setDone(true);
      return;
    }
    const delays = shuffleDelays();
    let t = 0;
    delays.forEach((d, i) => {
      t += d;
      const last = i === delays.length - 1;
      timers.current.push(
        window.setTimeout(() => {
          setShown(last ? final : (final + delays.length - i) % pool.length);
          if (last) setDone(true);
        }, t),
      );
    });
    return () => timers.current.forEach(clearTimeout);
  }, [round, pool.length]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const book = pool[shown]!;
  return (
    <div className="bb-spin-backdrop" onClick={onClose}>
      <div className="bb-spin" role="dialog" aria-modal="true" aria-labelledby="bb-spin-title" onClick={(e) => e.stopPropagation()}>
        <div className="bb-spin-head">
          <BarnabyAvatar size={56} />
          <h2 id="bb-spin-title" className="bb-kid-h2">
            {done ? "How about this one?" : "Barnaby is picking…"}
          </h2>
        </div>
        <div className={`bb-spin-cover${done ? " is-done" : ""}`} aria-hidden={!done}>
          <Cover book={book} />
        </div>
        <p className="bb-spin-title" aria-live="polite">
          {done ? book.title : " "}
        </p>
        <div className="bb-spin-actions">
          {done && (
            <Link to={linkFor(book)} className="bb-btn bb-btn-primary bb-btn-big">
              <span aria-hidden>📖</span> Read it!
            </Link>
          )}
          <button type="button" className="bb-btn bb-btn-big" onClick={() => setRound((r) => r + 1)} disabled={!done}>
            <span aria-hidden>🔄</span> Pick another
          </button>
          <button type="button" className="bb-btn bb-btn-big" onClick={onClose} ref={closeRef}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
