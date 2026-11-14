import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useSession } from "../app/session";
import { BarnabyEmpty, BarnabySays } from "../brand/Barnaby";
import { discoverApi, type DiscoverGroup, type DiscoverItem, type DiscoverList, type DiscoverResponse } from "./api";
import { ExploreLinks } from "./ExploreLinks";
import "./discover.css";

const SOURCE_LABEL: Record<DiscoverList["source"], string> = {
  library: "From your library",
  openlibrary: "From Open Library",
  hardcover: "From Hardcover",
  foryou: "From what you've read",
  awards: "Prize lists",
};

const GROUPS: { id: DiscoverGroup; title: string; kidTitle: string }[] = [
  { id: "foryou", title: "Picked for you", kidTitle: "Picked for you" },
  { id: "popular", title: "What people are reading", kidTitle: "What everyone's reading" },
  { id: "genres", title: "Browse by genre", kidTitle: "More to explore" },
  { id: "awards", title: "Prize winners", kidTitle: "Award winners" },
  { id: "family", title: "Around the house", kidTitle: "Around the house" },
];

const BECAUSE = "Because you read ";

/** Row title; "Because you read X" links X back to its book page. */
function RowTitle({ list }: { list: DiscoverList }) {
  if (list.aboutBookId && list.name.startsWith(BECAUSE))
    return (
      <>
        {BECAUSE}
        <Link to={`/book/${list.aboutBookId}`}>{list.name.slice(BECAUSE.length)}</Link>
      </>
    );
  return <>{list.name}</>;
}

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

function DiscoverCard({ item, canRequest: canRequestAll }: { item: DiscoverItem; canRequest: boolean }) {
  // Hand-picked kids' lists let a kid ask for a book even when other outside books are hidden.
  const canRequest = item.requestable ?? canRequestAll;
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
      {item.note && <span className="bb-dcard-note">{item.note}</span>}
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
  const grouped = GROUPS.map((g) => ({ ...g, lists: lists.filter((l) => (l.group ?? "popular") === g.id) })).filter((g) => g.lists.length);

  return (
    <div className="bb-page bb-discover">
      <ExploreLinks />
      <div className="bb-discover-head">
        <BarnabySays>
          {me?.isKid
            ? "Look what I found for you! Books like the ones you read, and what everyone else is reading."
            : "Picked from what you've been reading, plus what's popular and prize-winning. Anything we already have is marked."}
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
        {(data.requests || lists.some((l) => l.items.some((i) => i.requestable))) && (
          <>
            <span className="bb-dbadge is-request">Request it</span> ask for it to be added
          </>
        )}
      </p>
      {grouped.length > 1 && (
        <nav className="bb-dgroup-nav" aria-label="Jump to">
          {grouped.map((g) => (
            <a key={g.id} href={`#dg-${g.id}`} className="bb-dgroup-link">
              {me?.isKid ? g.kidTitle : g.title}
            </a>
          ))}
        </nav>
      )}
      {!data.online && (
        <p className="bb-muted bb-small">Outside lists are off on this server (METADATA_ONLINE=false).</p>
      )}
      {lists.length === 0 ? (
        <BarnabyEmpty title="Nothing to discover yet">Check back once people start reading.</BarnabyEmpty>
      ) : (
        grouped.map((g) => (
          <section key={g.id} className="bb-dgroup" id={`dg-${g.id}`} aria-labelledby={`dg-${g.id}-h`}>
            <h2 className="bb-dgroup-title" id={`dg-${g.id}-h`}>
              {me?.isKid ? g.kidTitle : g.title}
            </h2>
            {g.lists.map((l) => (
              <section key={l.id} className="bb-shelf" aria-labelledby={`dl-${l.id}`}>
                <header className="bb-shelf-head">
                  <h3 id={`dl-${l.id}`}>
                    <RowTitle list={l} />
                  </h3>
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
            ))}
          </section>
        ))
      )}
    </div>
  );
}
