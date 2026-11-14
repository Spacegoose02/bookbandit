import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { BookSummary } from "../api/types";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import { BookGrid } from "./BookCard";
import { FilterBar } from "./FilterBar";
import { filtersFromSearch, filtersToApiQuery, filtersToSearch, type LibraryFilters } from "./filters";

const PAGE = 48;

/** All books (or one shelf/section), with filters that live in the URL so they survive reloads and can be shared. */
export function BrowsePage({ title = "Library" }: { title?: string }) {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(params), [params]);
  const [draft, setDraft] = useState<LibraryFilters>(filters);
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [total, setTotal] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Typing updates the form immediately and the URL (and fetch) after a pause.
  useEffect(() => {
    const t = setTimeout(() => setParams(filtersToSearch(draft), { replace: true }), 250);
    return () => clearTimeout(t);
  }, [draft, setParams]);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .books(filtersToApiQuery(filters, me.maxRating, { limit: PAGE, offset: 0 }))
      .then((page) => {
        if (cancelled) return;
        setBooks(page.items);
        setTotal(page.total);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filters, me]);

  const loadMore = () => {
    if (!me) return;
    setLoading(true);
    api
      .books(filtersToApiQuery(filters, me.maxRating, { limit: PAGE, offset: books.length }))
      .then((page) => {
        setBooks((b) => [...b, ...page.items]);
        setTotal(page.total);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  if (!me) return null;
  const canLoadMore = total != null ? books.length < total : books.length > 0 && books.length % PAGE === 0;

  return (
    <div className="bb-page">
      <h1 className="bb-h1">{title}</h1>
      <FilterBar value={draft} onChange={setDraft} maxRating={me.maxRating} />
      {error && <p className="bb-error">Couldn't load books: {error}</p>}
      {!loading && !error && books.length === 0 ? (
        <BarnabyEmpty title="No books match">Try clearing a filter or searching for something else.</BarnabyEmpty>
      ) : (
        <>
          {total != null && <p className="bb-muted">{total === 1 ? "1 book" : `${total} books`}</p>}
          <BookGrid books={books} />
        </>
      )}
      {canLoadMore && (
        <div className="bb-center">
          <button className="bb-btn" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}
