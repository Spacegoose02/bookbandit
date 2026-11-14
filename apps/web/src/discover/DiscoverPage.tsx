import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useSession } from "../app/session";
import { BarnabyEmpty, BarnabySays } from "../brand/Barnaby";
import { discoverApi, type DiscoverItem, type DiscoverList, type DiscoverResponse } from "./api";
import { ExploreLinks } from "./ExploreLinks";
import "./discover.css";

const SOURCE_LABEL: Record<DiscoverList["source"], string> = {
  library: "From your family's reading",
  openlibrary: "From Open Library",
  hardcover: "From Hardcover",
};

function StatusBadge({ item }: { item: DiscoverItem }) {
  if (item.status === "library")
    return (
      <span className="bb-dbadge is-library">
        In library{item.onKindle ? " · Kindle" : ""}
      </span>
    );
  if (item.status === "kindle") return <span className="bb-dbadge is-kindle">On Kindle</span>;
  return null;
}

function DiscoverCard({ item, canRequest }: { item: DiscoverItem; canRequest: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "unavailable" | "in_library" | "error">("idle");
  const [found, setFound] = useState<{ id: string; title: string } | null>(null);
  const cover = item.bookId && item.coverPath ? api.coverUrl({ id: item.bookId, coverPath: item.coverPath }) : item.coverUrl;
  const art = cover ? (
    <img className="bb-cover" src={cover} alt="" loading="lazy" />
  ) : (
    <div className="bb-cover bb-cover-blank" aria-hidden>
      <span>{item.title}</span>
    </div>
  );
  const meta = [item.authors.slice(0, 2).join(", "), item.year].filter(Boolean).join(" · ");

  const ask = async () => {
    setState("sending");
    try {
      const r = await discoverApi.requestBook({ title: item.title, author: item.authors[0] ?? null, isbn13: item.isbn13 });
      if (r.status === "in_library") setFound(r.book);
      setState(r.status);
    } catch {
      setState("error");
    }
  };

  return (
    <article className="bb-dcard">
      {item.bookId ? (
        <Link to={`/book/${item.bookId}`} className="bb-dcard-cover" aria-label={item.title}>
          {art}
          <StatusBadge item={item} />
        </Link>
      ) : (
        <div className="bb-dcard-cover">{art}</div>
      )}
      <span className="bb-card-title">{item.bookId ? <Link to={`/book/${item.bookId}`}>{item.title}</Link> : item.title}</span>
      {meta && <span className="bb-card-meta">{meta}</span>}
      <div className="bb-dcard-action">
        {item.status === "kindle" && item.bookId && (
          <Link className="bb-btn bb-btn-small is-kindle" to={`/book/${item.bookId}`}>
            Read in Kindle
          </Link>
        )}
        {item.status === "request" && canRequest && state === "in_library" && found && (
          <Link className="bb-btn bb-btn-small" to={`/book/${found.id}`}>
            Already here: open
          </Link>
        )}
        {item.status === "request" && canRequest && state !== "in_library" && (
          <button
            className="bb-btn bb-btn-small bb-btn-primary"
            onClick={ask}
            disabled={state === "sending" || state === "sent" || state === "unavailable"}
          >
            {state === "sent" ? "Requested ✓" : state === "sending" ? "Asking…" : "Request it"}
          </button>
        )}
      </div>
      {state === "unavailable" && <span className="bb-small bb-muted">Requests aren't switched on yet.</span>}
      {state === "in_library" && found && <span className="bb-small bb-muted">It's already in the library as “{found.title}”.</span>}
      {state === "error" && <span className="bb-small bb-error">Couldn't send that request.</span>}
    </article>
  );
}

export function DiscoverPage() {
  const { me } = useSession();
  const [data, setData] = useState<DiscoverResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    discoverApi
      .discover()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <BarnabyEmpty title="Barnaby couldn't load Discover">{error}</BarnabyEmpty>;
  if (!data) return <div className="bb-page bb-muted">Loading…</div>;
  const lists = data.lists.filter((l) => l.items.length || l.error);

  return (
    <div className="bb-page bb-discover">
      <ExploreLinks />
      <div className="bb-discover-head">
        <BarnabySays>
          {me?.isKid ? "Look what everyone's reading!" : "Here's what people are reading right now. Anything we already have is marked."}
        </BarnabySays>
        {me?.role === "admin" && (
          <Link className="bb-btn" to="/discover/kindle-import">
            Import Kindle library
          </Link>
        )}
      </div>
      <p className="bb-legend bb-small">
        <span className="bb-dbadge is-library">In library</span> read it here
        <span className="bb-dbadge is-kindle">On Kindle</span> opens in the Kindle app
        {data.requests && (
          <>
            <span className="bb-dbadge is-request">Request it</span> ask for it to be added
          </>
        )}
      </p>
      {!data.online && (
        <p className="bb-muted bb-small">Outside lists are off on this server (METADATA_ONLINE=false).</p>
      )}
      {lists.length === 0 ? (
        <BarnabyEmpty title="Nothing to discover yet">Check back once people start reading.</BarnabyEmpty>
      ) : (
        lists.map((l) => (
          <section key={l.id} className="bb-shelf" aria-labelledby={`dl-${l.id}`}>
            <header className="bb-shelf-head">
              <h2 id={`dl-${l.id}`}>{l.name}</h2>
              <span className="bb-small bb-muted">{SOURCE_LABEL[l.source]}</span>
            </header>
            {l.error && !l.items.length ? (
              <p className="bb-muted bb-small">Couldn't reach {l.source === "hardcover" ? "Hardcover" : "Open Library"} just now.</p>
            ) : (
              <div className="bb-shelf-row">
                {l.items.map((i) => (
                  <DiscoverCard key={i.key} item={i} canRequest={data.requests} />
                ))}
              </div>
            )}
          </section>
        ))
      )}
    </div>
  );
}
