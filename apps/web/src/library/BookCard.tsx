import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { BookSummary } from "../api/types";

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

export function BookCard({ book, size = "md" }: { book: BookSummary; size?: "md" | "lg" }) {
  const author = book.authors?.map((a) => a.name).join(", ");
  const series = book.series?.[0];
  return (
    <Link to={`/book/${book.id}`} className={`bb-card bb-card-${size}`}>
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

export function BookGrid({ books, size = "md" }: { books: BookSummary[]; size?: "md" | "lg" }) {
  return (
    <div className={`bb-grid bb-grid-${size}`}>
      {books.map((b) => (
        <BookCard key={b.id} book={b} size={size} />
      ))}
    </div>
  );
}
