import { useEffect, useState } from "react";
import { BookCard } from "../library/BookCard";
import { aiApi, type FoundBook } from "./api";
import "./ai.css";

/**
 * "More like this" row on the book page. The server only returns books this reader may open
 * (kids stay inside their rating), and it works even when no AI provider is set up.
 */
export function MoreLikeThis({ bookId, kid }: { bookId: string; kid?: boolean }) {
  const [items, setItems] = useState<FoundBook[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    aiApi.similar(bookId, 8).then(
      (r) => !cancelled && setItems(r),
      () => !cancelled && setItems([]),
    );
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  if (!items?.length) return null;
  return (
    <section className="bb-shelf bb-more-like" aria-labelledby="bb-more-like-h">
      <div className="bb-shelf-head">
        <h2 id="bb-more-like-h">{kid ? "🦝 Barnaby thinks you'll like these too" : "More like this"}</h2>
      </div>
      <div className="bb-shelf-row">
        {items.map((b) => (
          <div key={b.id} className="bb-found">
            <BookCard book={b} />
            {b.reason && <span className="bb-found-reason">{b.reason}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
