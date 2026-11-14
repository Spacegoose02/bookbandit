import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { kindleReadUrl, RATING_LABELS } from "@bookbandit/shared";
import { api, ApiError } from "../api/client";
import type { BookDetail } from "../api/types";
import { BarnabyEmpty } from "../brand/Barnaby";
import { READABLE_FORMATS } from "../reader/formats";
import { BookCategories, useBookCategories } from "../discover/BookCategories";
import { Cover } from "./BookCard";
import { ListenButton } from "../audio/ListenButton";
import { SendToKindleButton } from "../kindle/SendToKindleButton";

export function BookPage() {
  const { id = "" } = useParams();
  const [book, setBook] = useState<BookDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categories = useBookCategories(book ? id : null);

  useEffect(() => {
    setBook(null);
    setMissing(false);
    api
      .book(id)
      .then(setBook)
      .catch((e: unknown) => {
        // Locked books are 404 on purpose, so "not here" covers both.
        if ((e instanceof ApiError && e.notFound) || (e as { notFound?: boolean }).notFound) setMissing(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
  }, [id]);

  if (missing)
    return (
      <BarnabyEmpty title="Barnaby can't find that book">
        <Link className="bb-btn" to="/">
          Back to books
        </Link>
      </BarnabyEmpty>
    );
  if (error) return <p className="bb-page bb-error">{error}</p>;
  if (!book) return <div className="bb-page bb-muted">Loading…</div>;

  const readable = book.files?.filter((f) => READABLE_FORMATS.includes(f.format)) ?? [];
  const pct = book.percent ? Math.round(book.percent * 100) : 0;

  return (
    <div className="bb-page bb-book">
      <div className="bb-book-cover">
        <Cover book={book} />
      </div>
      <div className="bb-book-info">
        <h1 className="bb-h1">{book.title}</h1>
        {book.subtitle && <p className="bb-subtitle">{book.subtitle}</p>}
        <p className="bb-muted">
          {book.authors?.map((a, i) => (
            <span key={a.id}>
              {i > 0 && ", "}
              <Link className="bb-link" to={`/browse?${new URLSearchParams({ author: a.id, authorName: a.name })}`}>
                {a.name}
              </Link>
            </span>
          ))}
          {book.publishedYear ? ` · ${book.publishedYear}` : ""}
        </p>
        {book.series?.map((s) => (
          <p key={s.id}>
            <Link className="bb-link" to={`/series/${encodeURIComponent(s.id)}`}>
              {s.name}
              {s.position != null ? `, book ${s.position}` : ""}
            </Link>
          </p>
        ))}
        <div className="bb-actions">
          {readable.length > 0 && (
            <Link className="bb-btn bb-btn-primary bb-btn-big" to={`/read/${book.id}`}>
              {pct > 0 && pct < 100 ? `Keep reading (${pct}%)` : "Read"}
            </Link>
          )}
          {readable.length > 0 && categories?.cookbook && (
            <Link className="bb-btn bb-btn-big" to={`/cook/${book.id}`}>
              🍳 Cook mode
            </Link>
          )}
          {book.kindleAsin && (
            <a
              className={`bb-btn bb-btn-big${book.kindleOnly ? " bb-btn-primary" : ""}`}
              href={kindleReadUrl(book.kindleAsin)}
              target="_blank"
              rel="noreferrer"
            >
              Read in Kindle
            </a>
          )}
          <ListenButton book={book} />
          <SendToKindleButton book={book} />
        </div>
        {book.kindleOnly && (
          <p className="bb-muted bb-small">This book lives in your Kindle library, so it opens in Amazon's Kindle reader.</p>
        )}
        {book.description && <p className="bb-description">{book.description}</p>}
        <BookCategories categories={categories} />
        <dl className="bb-facts">
          {book.rating && (
            <>
              <dt>Age group</dt>
              <dd>{RATING_LABELS[book.rating]}</dd>
            </>
          )}
          {book.publisher && (
            <>
              <dt>Publisher</dt>
              <dd>{book.publisher}</dd>
            </>
          )}
          {book.pageCount && (
            <>
              <dt>Pages</dt>
              <dd>{book.pageCount}</dd>
            </>
          )}
          {readable.length > 0 && (
            <>
              <dt>Formats</dt>
              <dd>{readable.map((f) => f.format.toUpperCase()).join(", ")}</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}
