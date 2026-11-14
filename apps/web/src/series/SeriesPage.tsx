import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { BookSummary } from "../api/types";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import { discoverApi, type SeriesBook, type SeriesDetail } from "../discover/api";
import { Cover } from "../library/BookCard";
import { moveItem, positionLabel } from "./order";
import "../discover/discover.css";

const isMissing = (e: unknown) => (e instanceof ApiError && e.notFound) || (e as { notFound?: boolean }).notFound;

function nextUp(books: SeriesBook[]): SeriesBook | undefined {
  // The first book this reader hasn't finished: in progress beats untouched.
  return books.find((b) => b.percent != null && b.percent > 0 && b.percent < 0.995) ?? books.find((b) => !b.percent);
}

/** A series in reading order. Admins can rename it, drag books into order, add and remove books. */
export function SeriesPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { me } = useSession();
  const admin = me?.role === "admin";
  const [series, setSeries] = useState<SeriesDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = admin && params.get("edit") === "1";

  useEffect(() => {
    setSeries(null);
    setMissing(false);
    discoverApi
      .series(id)
      .then(setSeries)
      .catch((e: unknown) => (isMissing(e) ? setMissing(true) : setError(e instanceof Error ? e.message : String(e))));
  }, [id]);

  if (missing)
    return (
      <BarnabyEmpty title="Barnaby can't find that series">
        <Link className="bb-btn" to="/series">
          All series
        </Link>
      </BarnabyEmpty>
    );
  if (error) return <p className="bb-page bb-error">{error}</p>;
  if (!series) return <div className="bb-page bb-muted">Loading…</div>;

  if (editing)
    return (
      <SeriesEditor
        series={series}
        onDone={(s) => {
          if (s) setSeries(s);
          setParams({}, { replace: true });
        }}
        onDeleted={() => navigate("/series", { replace: true })}
      />
    );

  const up = nextUp(series.books);
  return (
    <div className="bb-page bb-series">
      <p className="bb-small">
        <Link className="bb-link" to="/series">
          ← Series
        </Link>
      </p>
      <div className="bb-discover-head">
        <h1 className="bb-h1">{series.name}</h1>
        {admin && (
          <button className="bb-btn" onClick={() => setParams({ edit: "1" })}>
            Edit series
          </button>
        )}
      </div>
      {series.description && <p className="bb-description">{series.description}</p>}
      <p className="bb-muted">
        {series.books.length} {series.books.length === 1 ? "book" : "books"} in reading order
        {up && (
          <>
            {" · "}
            <Link className="bb-link" to={`/book/${up.id}`}>
              {up.percent ? "Keep reading" : "Next up"}: {up.title}
            </Link>
          </>
        )}
      </p>
      <ol className="bb-series-list">
        {series.books.map((b) => (
          <li key={b.id}>
            <Link to={`/book/${b.id}`} className="bb-series-row">
              <span className="bb-series-pos">{b.position ?? "·"}</span>
              <span className="bb-series-cover">
                <Cover book={b} />
              </span>
              <span className="bb-series-info">
                <strong>{b.title}</strong>
                <span className="bb-small bb-muted">
                  {[positionLabel(b.position), b.authors?.map((a) => a.name).join(", "), b.publishedYear].filter(Boolean).join(" · ")}
                </span>
                {b.kindleOnly && <span className="bb-dbadge is-kindle">On Kindle</span>}
              </span>
              <span className="bb-series-state">
                {b.percent != null && b.percent >= 0.995
                  ? "✓ Read"
                  : b.percent
                    ? `${Math.round(b.percent * 100)}%`
                    : ""}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      {series.books.length === 0 && <p className="bb-muted">No books in this series yet.</p>}
    </div>
  );
}

function SeriesEditor({
  series,
  onDone,
  onDeleted,
}: {
  series: SeriesDetail;
  onDone: (s?: SeriesDetail) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(series.name);
  const [description, setDescription] = useState(series.description ?? "");
  const [books, setBooks] = useState<SeriesBook[]>(series.books);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<BookSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!q.trim()) return setResults([]);
    const t = setTimeout(() => {
      api
        .books(new URLSearchParams({ q: q.trim(), limit: "8" }))
        .then((p) => setResults(p.items))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const move = (from: number, to: number) => setBooks((list) => moveItem(list, from, to));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (name.trim() !== series.name || (description.trim() || null) !== series.description)
        await discoverApi.updateSeries(series.id, { name: name.trim(), description: description.trim() || null });
      const saved = await discoverApi.setSeriesBooks(
        series.id,
        books.map((b) => ({ bookId: b.id })),
      );
      onDone({ ...series, name: name.trim(), description: description.trim() || null, adminManaged: true, books: saved });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await discoverApi.deleteSeries(series.id);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="bb-page bb-series bb-series-edit">
      <h1 className="bb-h1">Edit series</h1>
      <div className="bb-field">
        <label htmlFor="series-name">Name</label>
        <input id="series-name" className="bb-input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="bb-field">
        <label htmlFor="series-desc">Description</label>
        <textarea id="series-desc" className="bb-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <h2 className="bb-h2">Reading order</h2>
      <p className="bb-muted bb-small">Drag books by the handle, or use the arrows. Saving numbers them 1, 2, 3…</p>
      <ol className="bb-series-list is-editing">
        {books.map((b, i) => (
          <li
            key={b.id}
            draggable
            onDragStart={(e) => {
              setDragging(i);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", b.id);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(i);
            }}
            onDragLeave={() => setOver((o) => (o === i ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging != null) move(dragging, i);
              setDragging(null);
              setOver(null);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            className={`${dragging === i ? "is-dragging" : ""}${over === i && dragging !== i ? " is-over" : ""}`}
          >
            <div className="bb-series-row">
              <span className="bb-drag" aria-hidden title="Drag to reorder">
                ⠿
              </span>
              <span className="bb-series-pos">{i + 1}</span>
              <span className="bb-series-cover">
                <Cover book={b} />
              </span>
              <span className="bb-series-info">
                <strong>{b.title}</strong>
                <span className="bb-small bb-muted">{b.authors?.map((a) => a.name).join(", ")}</span>
              </span>
              <span className="bb-series-tools">
                <button className="bb-icon-btn" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${b.title} up`}>
                  ↑
                </button>
                <button
                  className="bb-icon-btn"
                  onClick={() => move(i, i + 1)}
                  disabled={i === books.length - 1}
                  aria-label={`Move ${b.title} down`}
                >
                  ↓
                </button>
                <button
                  className="bb-icon-btn"
                  onClick={() => setBooks((list) => list.filter((x) => x.id !== b.id))}
                  aria-label={`Remove ${b.title} from the series`}
                >
                  ✕
                </button>
              </span>
            </div>
          </li>
        ))}
      </ol>
      <div className="bb-field">
        <label htmlFor="series-add">Add a book</label>
        <input
          id="series-add"
          className="bb-input"
          type="search"
          placeholder="Search the library"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {results.length > 0 && (
        <ul className="bb-list bb-series-results">
          {results
            .filter((r) => !books.some((b) => b.id === r.id))
            .map((r) => (
              <li key={r.id}>
                <button
                  className="bb-list-btn"
                  onClick={() => {
                    setBooks((list) => [...list, { ...r, position: null }]);
                    setQ("");
                  }}
                >
                  + {r.title}
                  <span className="bb-muted"> {r.authors?.map((a) => a.name).join(", ")}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
      {error && <p className="bb-error">{error}</p>}
      <div className="bb-actions">
        <button className="bb-btn bb-btn-primary" onClick={save} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="bb-btn" onClick={() => onDone()} disabled={busy}>
          Cancel
        </button>
        <span className="bb-spacer" />
        {confirmDelete ? (
          <>
            <span className="bb-small">Delete this series? Books stay in the library.</span>
            <button className="bb-btn bb-btn-danger" onClick={remove} disabled={busy}>
              Delete
            </button>
            <button className="bb-btn bb-btn-ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="bb-btn bb-btn-ghost" onClick={() => setConfirmDelete(true)}>
            Delete series
          </button>
        )}
      </div>
    </div>
  );
}
