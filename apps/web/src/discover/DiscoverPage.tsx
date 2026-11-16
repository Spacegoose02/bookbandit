import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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

interface Group {
  id: DiscoverGroup;
  title: string;
}

/** Section order and titles: a kid's own rows come right after "Picked for you". */
const GROUPS: Group[] = [
  { id: "foryou", title: "Picked for you" },
  { id: "library", title: "From our shelves" },
  { id: "moods", title: "Pick a mood" },
  { id: "popular", title: "What people are reading" },
  { id: "kids", title: "For the kids" },
  { id: "genres", title: "Browse by genre" },
  { id: "awards", title: "Prize winners" },
  { id: "family", title: "Around the house" },
];
const KID_GROUPS: Group[] = [
  { id: "foryou", title: "Picked for you" },
  { id: "kids", title: "Books for you" },
  { id: "library", title: "New on the shelf" },
  { id: "moods", title: "How do you feel today?" },
  { id: "popular", title: "What everyone's reading" },
  { id: "genres", title: "More to explore" },
  { id: "awards", title: "Award winners" },
  { id: "family", title: "Around the house" },
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

function Row({ list, canRequest }: { list: DiscoverList; canRequest: boolean }) {
  return (
    <section className="bb-shelf" aria-labelledby={`dl-${list.id}`}>
      <header className="bb-shelf-head">
        <div>
          <h3 id={`dl-${list.id}`}>
            <RowTitle list={list} />
          </h3>
          {list.blurb && <p className="bb-small bb-muted bb-shelf-blurb">{list.blurb}</p>}
        </div>
        <span className="bb-small bb-muted">{SOURCE_LABEL[list.source]}</span>
      </header>
      {list.error && !list.items.length ? (
        <p className="bb-muted bb-small">Couldn't reach {list.source === "hardcover" ? "Hardcover" : "Open Library"} just now.</p>
      ) : (
        <div className="bb-shelf-row">
          {list.items.map((i) => (
            <DiscoverCard key={i.key} item={i} canRequest={canRequest} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Mood rows as tabs: one mood at a time. */
function Moods({ lists, canRequest, onSurprise }: { lists: DiscoverList[]; canRequest: boolean; onSurprise: (mood: string) => void }) {
  const [active, setActive] = useState(lists[0]!.id);
  const current = lists.find((l) => l.id === active) ?? lists[0]!;
  return (
    <div className="bb-moods">
      <div className="bb-mood-tabs" role="tablist" aria-label="Moods">
        {lists.map((l) => (
          <button
            key={l.id}
            role="tab"
            aria-selected={l.id === current.id}
            className={`bb-mood-tab${l.id === current.id ? " active" : ""}`}
            onClick={() => setActive(l.id)}
          >
            {MOOD_ICON[l.id] ?? "📚"} {l.name}
          </button>
        ))}
        <button className="bb-mood-tab is-dice" onClick={() => onSurprise(current.id)}>
          🎲 Surprise me: {current.name.toLowerCase()}
        </button>
      </div>
      <Row list={current} canRequest={canRequest} />
    </div>
  );
}

const MOOD_ICON: Record<string, string> = {
  "mood-cozy": "☕",
  "mood-thrilling": "⚡",
  "mood-funny": "😄",
  "mood-heartwarming": "💛",
  "mood-spooky": "👻",
  "mood-curious": "🔭",
  "mood-epic": "🐉",
};

export function DiscoverPage() {
  const { me } = useSession();
  const [data, setData] = useState<DiscoverResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dice, setDice] = useState<"idle" | "rolling" | "empty">("idle");
  const navigate = useNavigate();

  const surprise = async (opts: { kids?: boolean; mood?: string } = {}) => {
    setDice("rolling");
    try {
      const book = await discoverApi.surprise(opts);
      if (book) navigate(`/book/${book.id}`);
      else setDice("empty");
    } catch {
      setDice("empty");
    }
  };

  useEffect(() => {
    discoverApi
      .discover()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <BarnabyEmpty title="Barnaby couldn't load Discover">{error}</BarnabyEmpty>;
  if (!data) return <div className="bb-page bb-muted">Loading…</div>;
  const lists = data.lists.filter((l) => l.items.length || l.error);
  const grouped = (me?.isKid ? KID_GROUPS : GROUPS)
    .map((g) => ({ ...g, lists: lists.filter((l) => (l.group ?? "popular") === g.id) }))
    .filter((g) => g.lists.length);

  return (
    <div className="bb-page bb-discover">
      <ExploreLinks />
      <div className="bb-discover-head">
        <BarnabySays>
          {me?.isKid
            ? "Look what I found for you! Pick a mood, try a theme, or let me pick a book for you."
            : "Picked from what you've been reading, our own shelves, moods, and what's popular and prize-winning. Anything we already have is marked."}
        </BarnabySays>
        <div className="bb-discover-actions">
          <button className="bb-btn bb-btn-primary bb-dice" onClick={() => surprise()} disabled={dice === "rolling"}>
            🎲 {me?.isKid ? "Pick a book for me!" : "Surprise me"}
          </button>
          {!me?.isKid && (
            <button className="bb-btn" onClick={() => surprise({ kids: true })} disabled={dice === "rolling"}>
              🧸 Surprise a kid
            </button>
          )}
          {me?.role === "admin" && (
            <Link className="bb-btn" to="/discover/kindle-import">
              Import Kindle library
            </Link>
          )}
        </div>
      </div>
      {dice === "empty" && (
        <p className="bb-small bb-muted" role="status">
          Barnaby looked everywhere, but there's nothing new left to pick. Try another mood!
        </p>
      )}
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
              {g.title}
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
              {g.title}
            </h2>
            {g.id === "moods" ? (
              <Moods lists={g.lists} canRequest={data.requests} onSurprise={(mood) => surprise({ mood })} />
            ) : (
              g.lists.map((l) => <Row key={l.id} list={l} canRequest={data.requests} />)
            )}
          </section>
        ))
      )}
    </div>
  );
}
