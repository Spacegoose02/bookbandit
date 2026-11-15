import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { BookSummary } from "../api/types";
import { BarnabyEmpty } from "../brand/Barnaby";
import { BookGrid } from "../library/BookCard";
import { useSession } from "../app/session";
import { discoverApi, type Category, type CategoryPage } from "./api";
import { ExploreLinks } from "./ExploreLinks";
import "./discover.css";
import { useBookEditor, useBookEdited } from "../admin/BookEditHost";
import { adminApi } from "../admin/api";
import { ErrorNote, useAction, useLoad } from "../admin/ui";
import { librarianApi } from "../librarian/api";

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
  const { me } = useSession();
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
        {me?.role === "admin" && (
          <Link className="bb-btn" to="/admin/categories">
            Manage categories
          </Link>
        )}
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
  const [version, setVersion] = useState(0);
  const edit = useBookEditor();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useBookEdited(useCallback(() => setVersion((v) => v + 1), []));

  useEffect(() => {
    if (!version) setPage(null);
    setMissing(false);
    discoverApi
      .category(id)
      .then(setPage)
      .catch((e: unknown) => (isMissing(e) ? setMissing(true) : setError(e instanceof Error ? e.message : String(e))));
  }, [id, version]);

  useEffect(() => {
    setSelecting(false);
    setSelected(new Set());
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

  const toggle = (bookId: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(bookId)) n.delete(bookId);
      else n.add(bookId);
      return n;
    });

  return (
    <div className="bb-page">
      <p className="bb-small">
        <Link className="bb-link" to="/categories">
          ← Categories
        </Link>
      </p>
      <div className="bb-page-head">
        <div>
          <h1 className="bb-h1">
            {page.category.cookbook && <span aria-hidden>🍳 </span>}
            {page.category.name}
          </h1>
          <p className="bb-muted">
            {page.total} {page.total === 1 ? "book" : "books"}
            {page.category.cookbook && " · open any of them in Cook mode from its page"}
          </p>
        </div>
        {edit && (
          <button
            className="bb-btn"
            aria-pressed={selecting}
            onClick={() => {
              setSelecting(!selecting);
              setSelected(new Set());
            }}
          >
            {selecting ? "Done" : "Select books"}
          </button>
        )}
      </div>
      {selecting && (
        <MoveBar
          category={page.category.name}
          selected={[...selected]}
          allIds={page.items.map((b) => b.id)}
          onSelectAll={(ids) => setSelected(new Set(ids))}
          onDone={() => {
            setSelected(new Set());
            setVersion((v) => v + 1);
          }}
        />
      )}
      <BookGrid books={page.items} selection={selecting ? { selected, toggle } : undefined} />
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

/** Admin bar on a category page: move, add or remove the selected books. Their categories get locked. */
function MoveBar({
  category,
  selected,
  allIds,
  onSelectAll,
  onDone,
}: {
  category: string;
  selected: string[];
  allIds: string[];
  onSelectAll: (ids: string[]) => void;
  onDone: () => void;
}) {
  const names = useLoad(() => adminApi.categoryNames(), []);
  const [target, setTarget] = useState("");
  const action = useAction();
  const [note, setNote] = useState<string | null>(null);
  const n = selected.length;
  const run = (change: { tagsAdd?: string[]; tagsRemove?: string[] }, done: string) =>
    action.run(async () => {
      await librarianApi.bulk({ ids: selected, ...change });
      setNote(done);
      onDone();
    });

  return (
    <div className="bb-select-bar" role="toolbar" aria-label="Selected books">
      <strong>{n ? `${n} selected` : "Pick books"}</strong>
      <button className="bb-btn bb-btn-small bb-btn-ghost" onClick={() => onSelectAll(n === allIds.length ? [] : allIds)}>
        {n === allIds.length && n ? "Select none" : "Select all"}
      </button>
      <select className="bb-input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Category to move to">
        <option value="">Choose a category…</option>
        {(names.data ?? [])
          .filter((c) => c !== category)
          .map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
      </select>
      <button
        className="bb-btn bb-btn-primary bb-btn-small"
        disabled={!n || !target || action.busy}
        onClick={() => void run({ tagsAdd: [target], tagsRemove: [category] }, `Moved ${n} to ${target}.`)}
      >
        Move
      </button>
      <button className="bb-btn bb-btn-small" disabled={!n || !target || action.busy} onClick={() => void run({ tagsAdd: [target] }, `Added ${n} to ${target}.`)}>
        Also add
      </button>
      <button className="bb-btn bb-btn-small" disabled={!n || action.busy} onClick={() => void run({ tagsRemove: [category] }, `Took ${n} out of ${category}.`)}>
        Remove from {category}
      </button>
      {note && !action.error && <span className="bb-muted bb-small">{note}</span>}
      <ErrorNote error={action.error} />
    </div>
  );
}
