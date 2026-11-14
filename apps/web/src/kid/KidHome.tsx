import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { BookSummary, Shelf } from "../api/types";
import { useSession } from "../app/session";
import { BarnabyEmpty, BarnabySays } from "../brand/Barnaby";
import { Cover } from "../library/BookCard";

/**
 * Kid mode home, built for a 7 year old on a tablet: no search box, no filters,
 * no text-heavy menus. Big covers, one tap to read, and Barnaby to say hi.
 * The server already limits which books a kid gets, so this just shows what comes back.
 */
export function KidHome() {
  const { me } = useSession();
  const [shelves, setShelves] = useState<Shelf[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.shelves().then(setShelves, () => setError(true));
  }, []);

  if (error) return <BarnabyEmpty title="Uh oh! Ask a grown-up to check the library." />;
  if (!shelves) return <div className="bb-page bb-muted">Loading…</div>;

  const keepReading = shelves.find((s) => s.kind === "continue")?.books ?? [];
  const seen = new Set(keepReading.map((b) => b.id));
  const mine = shelves
    .filter((s) => s.kind !== "continue")
    .flatMap((s) => s.books)
    .filter((b) => !seen.has(b.id) && (seen.add(b.id), true));

  return (
    <div className="bb-page bb-kid">
      <BarnabySays size={72}>
        <span className="bb-kid-hello">Hi {me?.displayName}! Pick a book!</span>
      </BarnabySays>
      <p className="bb-kid-ask-link">
        <Link to="/requests" className="bb-btn bb-btn-big">
          <span aria-hidden>🌟</span> Wish for a new book
        </Link>
      </p>
      {keepReading.length > 0 && (
        <section>
          <h2 className="bb-kid-h2">
            <span aria-hidden>📖</span> Keep reading
          </h2>
          <div className="bb-kid-grid">
            {keepReading.map((b) => (
              <KidBook key={b.id} book={b} />
            ))}
          </div>
        </section>
      )}
      <section>
        <h2 className="bb-kid-h2">
          <span aria-hidden>📚</span> My books
        </h2>
        {mine.length ? (
          <div className="bb-kid-grid">
            {mine.map((b) => (
              <KidBook key={b.id} book={b} />
            ))}
          </div>
        ) : (
          <BarnabyEmpty title="No books yet! Ask a grown-up to add some." />
        )}
      </section>
    </div>
  );
}

function KidBook({ book }: { book: BookSummary }) {
  // Kids go straight into the book; the details page is for grown-ups.
  const to = book.kindleOnly ? `/book/${book.id}` : `/read/${book.id}`;
  return (
    <Link to={to} className="bb-kid-book">
      <Cover book={book} />
      {book.percent != null && book.percent > 0 && (
        <span className="bb-kid-stars" aria-label={`${Math.round(book.percent * 100)}% read`}>
          {"⭐".repeat(Math.max(1, Math.round(book.percent * 5)))}
        </span>
      )}
      <span className="bb-kid-title">{book.title}</span>
    </Link>
  );
}
