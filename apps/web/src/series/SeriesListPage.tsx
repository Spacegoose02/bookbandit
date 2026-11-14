import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useSession } from "../app/session";
import { BarnabyEmpty } from "../brand/Barnaby";
import { discoverApi, type SeriesSummary } from "../discover/api";
import { ExploreLinks } from "../discover/ExploreLinks";
import "../discover/discover.css";

export function SeriesListPage() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [items, setItems] = useState<SeriesSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [newName, setNewName] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(
      () =>
        discoverApi
          .seriesList(q.trim() || undefined)
          .then((r) => setItems(r.items))
          .catch((e: Error) => setError(e.message)),
      q ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [q]);

  const create = async () => {
    if (!newName?.trim()) return;
    const { id } = await discoverApi.createSeries(newName.trim(), []);
    navigate(`/series/${encodeURIComponent(id)}?edit=1`);
  };

  if (error) return <BarnabyEmpty title="Barnaby couldn't load series">{error}</BarnabyEmpty>;

  return (
    <div className="bb-page">
      <ExploreLinks />
      <div className="bb-discover-head">
        <h1 className="bb-h1">Series</h1>
        <input
          className="bb-input bb-cat-filter"
          type="search"
          placeholder="Find a series"
          aria-label="Find a series"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {me?.role === "admin" &&
          (newName === null ? (
            <button className="bb-btn" onClick={() => setNewName("")}>
              New series
            </button>
          ) : (
            <form
              className="bb-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <input
                className="bb-input"
                autoFocus
                placeholder="Series name"
                aria-label="New series name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button className="bb-btn bb-btn-primary" disabled={!newName.trim()}>
                Create
              </button>
              <button type="button" className="bb-btn bb-btn-ghost" onClick={() => setNewName(null)}>
                Cancel
              </button>
            </form>
          ))}
      </div>
      {!items ? (
        <p className="bb-muted">Loading…</p>
      ) : items.length === 0 ? (
        <BarnabyEmpty title={q ? "No series match that" : "No series yet"}>
          Series come from book metadata{me?.role === "admin" ? ", or make your own with New series" : ""}.
        </BarnabyEmpty>
      ) : (
        <div className="bb-cat-grid">
          {items.map((s) => (
            <Link key={s.id} to={`/series/${encodeURIComponent(s.id)}`} className="bb-cat-tile">
              <div className="bb-stack" aria-hidden>
                {s.books.slice(0, 3).map((b) => {
                  const url = api.coverUrl(b);
                  return url ? <img key={b.id} src={url} alt="" loading="lazy" /> : <span key={b.id} className="bb-stack-blank" />;
                })}
              </div>
              <span className="bb-cat-name">{s.name}</span>
              <span className="bb-small bb-muted">
                {s.bookCount} {s.bookCount === 1 ? "book" : "books"}
                {s.adminManaged ? " · curated" : ""}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
