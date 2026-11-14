import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { BookSummary } from "../api/types";
import { BarnabyEmpty } from "../brand/Barnaby";
import { BookGrid } from "../library/BookCard";
import { discoverApi, type Category, type CategoryPage } from "./api";
import { ExploreLinks } from "./ExploreLinks";
import "./discover.css";

const isMissing = (e: unknown) => (e instanceof ApiError && e.notFound) || (e as { notFound?: boolean }).notFound;

function CoverStack({ books }: { books: BookSummary[] }) {
  return (
    <div className="bb-stack" aria-hidden>
      {books.slice(0, 3).map((b) => {
        const url = api.coverUrl(b);
        return url ? <img key={b.id} src={url} alt="" loading="lazy" /> : <span key={b.id} className="bb-stack-blank" />;
      })}
    </div>
  );
}

/** Every category with books this reader can see: sections (Kids, Cookbooks) first, then genres. */
export function CategoriesPage() {
  const [items, setItems] = useState<Category[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    discoverApi
      .categories()
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <BarnabyEmpty title="Barnaby couldn't load categories">{error}</BarnabyEmpty>;
  if (!items) return <div className="bb-page bb-muted">Loading…</div>;
  const shown = items.filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="bb-page">
      <ExploreLinks />
      <div className="bb-discover-head">
        <h1 className="bb-h1">Categories</h1>
        {items.length > 12 && (
          <input
            className="bb-input bb-cat-filter"
            type="search"
            placeholder="Find a category"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Find a category"
          />
        )}
      </div>
      {items.length === 0 ? (
        <BarnabyEmpty title="No categories yet">Categories come from book metadata and appear once books are added.</BarnabyEmpty>
      ) : (
        <div className="bb-cat-grid">
          {shown.map((c) => (
            <Link key={c.id} to={`/categories/${encodeURIComponent(c.id)}`} className={`bb-cat-tile${c.kind === "section" ? " is-section" : ""}`}>
              <CoverStack books={c.books} />
              <span className="bb-cat-name">
                {c.cookbook && <span aria-hidden>🍳 </span>}
                {c.name}
              </span>
              <span className="bb-small bb-muted">
                {c.bookCount} {c.bookCount === 1 ? "book" : "books"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function CategoryPageView() {
  const { id = "" } = useParams();
  const [page, setPage] = useState<CategoryPage | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    setPage(null);
    setMissing(false);
    discoverApi
      .category(id)
      .then(setPage)
      .catch((e: unknown) => (isMissing(e) ? setMissing(true) : setError(e instanceof Error ? e.message : String(e))));
  }, [id]);

  const loadMore = async () => {
    if (!page) return;
    setMore(true);
    try {
      const next = await discoverApi.category(id, page.items.length);
      setPage({ ...page, items: [...page.items, ...next.items], total: next.total });
    } finally {
      setMore(false);
    }
  };

  if (missing)
    return (
      <BarnabyEmpty title="Barnaby can't find that category">
        <Link className="bb-btn" to="/categories">
          All categories
        </Link>
      </BarnabyEmpty>
    );
  if (error) return <p className="bb-page bb-error">{error}</p>;
  if (!page) return <div className="bb-page bb-muted">Loading…</div>;

  return (
    <div className="bb-page">
      <p className="bb-small">
        <Link className="bb-link" to="/categories">
          ← Categories
        </Link>
      </p>
      <h1 className="bb-h1">
        {page.category.cookbook && <span aria-hidden>🍳 </span>}
        {page.category.name}
      </h1>
      <p className="bb-muted">
        {page.total} {page.total === 1 ? "book" : "books"}
        {page.category.cookbook && " · open any of them in Cook mode from its page"}
      </p>
      <BookGrid books={page.items} />
      {page.items.length < page.total && (
        <div className="bb-center">
          <button className="bb-btn" onClick={loadMore} disabled={more}>
            {more ? "Loading…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}
