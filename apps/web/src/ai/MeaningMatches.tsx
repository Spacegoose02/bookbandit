import { useEffect, useState } from "react";
import { BookCard } from "../library/BookCard";
import { aiApi, type FoundBook } from "./api";
import { useAiStatus } from "./useAiStatus";
import "./ai.css";

/**
 * Library search, part two: books whose story matches the words, found by meaning search.
 * Shown under the normal title/author results, minus books already listed there.
 */
export function MeaningMatches({ q, exclude }: { q: string; exclude: string[] }) {
  const status = useAiStatus();
  const [items, setItems] = useState<FoundBook[] | null>(null);
  const [loading, setLoading] = useState(false);
  const on = !!status?.meaningSearch && q.trim().length >= 3;

  useEffect(() => {
    if (!on) return setItems(null);
    let cancelled = false;
    setLoading(true);
    aiApi
      .meaningSearch(q.trim(), 12)
      .then(
        (r) => !cancelled && setItems(r.items),
        () => !cancelled && setItems([]),
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [q, on]);

  if (!on) return null;
  const skip = new Set(exclude);
  const shown = (items ?? []).filter((b) => !skip.has(b.id));
  if (!loading && !shown.length) return null;
  return (
    <section className="bb-shelf bb-meaning" aria-labelledby="bb-meaning-h" aria-busy={loading}>
      <div className="bb-shelf-head">
        <h2 id="bb-meaning-h">🦝 Barnaby also found, by what they're about</h2>
      </div>
      {loading && !items ? (
        <p className="bb-muted">Sniffing through the stories…</p>
      ) : (
        <div className="bb-grid">
          {shown.map((b) => (
            <BookCard key={b.id} book={b} />
          ))}
        </div>
      )}
    </section>
  );
}
