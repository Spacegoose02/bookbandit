import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { BookSummary } from "../api/types";
import { useBookEditor } from "../admin/BookEditHost";

export function Cover({ book, className = "" }: { book: Pick<BookSummary, "id" | "coverPath" | "title">; className?: string }) {
  const url = api.coverUrl(book);
  return url ? (
    <img className={`bb-cover ${className}`} src={url} alt="" loading="lazy" />
  ) : (
    <div className={`bb-cover bb-cover-blank ${className}`} aria-hidden>
      <span>{book.title}</span>
    </div>
  );
}

/** Multi-select on a grid: a circle on each cover, and clicking a card selects it. */
export interface GridSelection {
  selected: Set<string>;
  toggle: (bookId: string) => void;
}

export function BookCard({ book, size = "md", selection }: { book: BookSummary; size?: "md" | "lg"; selection?: GridSelection }) {
  const edit = useBookEditor();
  const selected = selection?.selected.has(book.id) ?? false;
  return (
    <div className={`bb-card-wrap${selected ? " is-selected" : ""}`}>
      <CardLink book={book} size={size} onSelect={selection ? () => selection.toggle(book.id) : undefined} />
      {selection && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${book.title}`}
          className="bb-card-tool bb-card-select"
          onClick={() => selection.toggle(book.id)}
        >
          ✓
        </button>
      )}
      {edit && !selection && (
        <button type="button" className="bb-card-tool bb-card-edit" aria-label={`Edit ${book.title}`} title="Edit details and cover" onClick={() => edit(book.id)}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M11.3 2.3a1.4 1.4 0 0 1 2 2L5.6 12 2.5 13l1-3.1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

function CardLink({ book, size, onSelect }: { book: BookSummary; size: "md" | "lg"; onSelect?: () => void }) {
  const author = book.authors?.map((a) => a.name).join(", ");
  const series = book.series?.[0];
  return (
    <Link
      to={`/book/${book.id}`}
      className={`bb-card bb-card-${size}`}
      onClick={
        onSelect
          ? (e) => {
              e.preventDefault();
              onSelect();
            }
          : undefined
      }
    >
      <div className="bb-card-cover">
        <Cover book={book} />
        {book.kindleOnly && <span className="bb-badge">Kindle</span>}
        {book.percent != null && book.percent > 0 && (
          <span className="bb-progress" aria-label={`${Math.round(book.percent * 100)}% read`}>
            <span style={{ width: `${Math.min(100, book.percent * 100)}%` }} />
          </span>
        )}
      </div>
      <span className="bb-card-title">{book.title}</span>
      {size === "md" && (
        <span className="bb-card-meta">
          {author}
          {series && (
            <>
              {author ? " · " : ""}
              {series.name}
              {series.position != null ? ` #${series.position}` : ""}
            </>
          )}
        </span>
      )}
    </Link>
  );
}

export function BookGrid({ books, size = "md", selection }: { books: BookSummary[]; size?: "md" | "lg"; selection?: GridSelection }) {
  return (
    <div className={`bb-grid bb-grid-${size}`}>
      {books.map((b) => (
        <BookCard key={b.id} book={b} size={size} selection={selection} />
      ))}
    </div>
  );
}
