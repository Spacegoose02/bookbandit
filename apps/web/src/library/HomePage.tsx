import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Shelf } from "../api/types";
import { useSession } from "../app/session";
import { BarnabyEmpty, BarnabySays } from "../brand/Barnaby";
import { BookCard } from "./BookCard";

export function ShelfRow({ shelf }: { shelf: Shelf }) {
  return (
    <section className="bb-shelf" aria-labelledby={`shelf-${shelf.id}`}>
      <header className="bb-shelf-head">
        <h2 id={`shelf-${shelf.id}`}>{shelf.name}</h2>
        {shelf.kind !== "continue" && (
          <Link className="bb-link" to={`/browse?shelf=${encodeURIComponent(shelf.id)}`}>
            See all
          </Link>
        )}
      </header>
      <div className="bb-shelf-row">
        {shelf.books.map((b) => (
          <BookCard key={b.id} book={b} />
        ))}
      </div>
    </section>
  );
}

export function HomePage() {
  const { me } = useSession();
  const [shelves, setShelves] = useState<Shelf[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .shelves()
      .then(setShelves)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <BarnabyEmpty title="Barnaby couldn't reach the library">{error}</BarnabyEmpty>;
  if (!shelves) return <div className="bb-page bb-muted">Loading…</div>;
  const nonEmpty = shelves.filter((s) => s.books.length);

  return (
    <div className="bb-page">
      <BarnabySays>
        Hi {me?.displayName ?? "there"}! {nonEmpty.some((s) => s.kind === "continue") ? "Pick up where you left off?" : "What shall we read today?"}
      </BarnabySays>
      {nonEmpty.length === 0 ? (
        <BarnabyEmpty title="No books yet">Books show up here once they're added to the library.</BarnabyEmpty>
      ) : (
        nonEmpty.map((s) => <ShelfRow key={s.id} shelf={s} />)
      )}
    </div>
  );
}
