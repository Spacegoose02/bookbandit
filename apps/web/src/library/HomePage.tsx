import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { BookSummary, Shelf } from "../api/types";
import { useSession } from "../app/session";
import { BarnabyAvatar, BarnabyEmpty } from "../brand/Barnaby";
import { adminApi, type Overview } from "../admin/api";
import { aiApi, type FoundBook } from "../ai/api";
import { useAiStatus } from "../ai/useAiStatus";
import { audioApi, type ListeningItem } from "../audio/api";
import { discoverApi, type Category } from "../discover/api";
import { requestsApi } from "../requests/api";
import type { RequestSummary } from "../requests/types";
import { BookCard, Cover } from "./BookCard";
import {
  deskItems,
  extraShelves,
  genreRowCandidates,
  greeting,
  jumpBackIn,
  MIN_ROW_BOOKS,
  seriesToContinue,
  splitByAudience,
  timeLeft,
  type InProgress,
  type SeriesPick,
} from "./home";
import "./home.css";

export function ShelfRow({ shelf, title, seeAll }: { shelf: Shelf; title?: string; seeAll?: string }) {
  const more = !!seeAll || (shelf.kind !== "continue" && (shelf.total == null || shelf.total > shelf.books.length));
  return (
    <section className="bb-shelf bb-home-section" aria-labelledby={`shelf-${shelf.id}`}>
      <header className="bb-home-head">
        <h2 id={`shelf-${shelf.id}`}>{title ?? shelf.name}</h2>
        {more && (
          <Link className="bb-link" to={seeAll ?? `/browse?shelf=${encodeURIComponent(shelf.id)}`}>
            See all{shelf.total ? ` ${shelf.total.toLocaleString()}` : ""}
          </Link>
        )}
      </header>
      <div className="bb-shelf-row">
        {shelf.books.map((b) => (
          <BookCard key={b.id} book={b} />
        ))}
      </div>
    </section>
  );
}

/** Loads something optional for the home page; a failure just hides that section. */
function useOptional<T>(load: (() => Promise<T>) | null, deps: unknown[]): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!load) return setValue(null);
    let live = true;
    load().then(
      (v) => live && setValue(v),
      () => live && setValue(null),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

export function HomePage() {
  const { me } = useSession();
  const ai = useAiStatus();
  const [shelves, setShelves] = useState<Shelf[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.shelves().then(setShelves, (e: Error) => setError(e.message));
  }, []);

  const role = me?.role;
  const listening = useOptional<ListeningItem[]>(() => audioApi.continueListening(), []);
  const categories = useOptional<Category[]>(() => discoverApi.categories(), []);
  const overview = useOptional<Overview>(role === "admin" ? () => adminApi.overview() : null, [role]);
  const requests = useOptional<RequestSummary>(() => requestsApi.summary(), []);
  const newest = useOptional<BookSummary[]>(
    () => api.books(new URLSearchParams({ sort: "added", limit: "80" })).then((p) => p.items),
    [],
  );
  const genreKey = categories ? genreRowCandidates(categories).map((c) => c.id).join(",") : "";
  const genreRows = useOptional<Shelf[]>(
    genreKey && categories
      ? () =>
          Promise.all(
            genreRowCandidates(categories).map((c) =>
              discoverApi.category(c.id).then(
                (p): Shelf => ({ id: `genre:${c.id}`, name: c.name, kind: "tag", total: p.total, books: p.items.slice(0, 20) }),
                () => null,
              ),
            ),
          ).then((rows) => rows.filter((r): r is Shelf => !!r && r.books.length >= MIN_ROW_BOOKS))
      : null,
    [genreKey],
  );

  const byKind = (k: Shelf["kind"]) => shelves?.find((s) => s.kind === k && s.books.length) ?? null;
  const reading = byKind("continue")?.books ?? [];
  const recent = byKind("recent");
  const inProgress = useMemo(() => jumpBackIn(reading, listening ?? []), [reading, listening]);
  const inProgressIds = useMemo(() => new Set(inProgress.map((i) => i.book.id)), [inProgress]);
  const series = useMemo(() => seriesToContinue(shelves ?? [], inProgressIds), [shelves, inProgressIds]);
  const extras = useMemo(() => extraShelves(shelves ?? []), [shelves]);

  const anchor = reading[0] ?? null;
  const similar = useOptional<FoundBook[]>(anchor ? () => aiApi.similar(anchor.id, 12) : null, [anchor?.id]);
  const audience = useMemo(() => (newest ? splitByAudience(newest) : null), [newest]);
  // Grown-ups' "Recently added" leaves out picture books; kids' books get their own row.
  const recentRow: Shelf | null =
    recent && audience?.grownUp.length
      ? { ...recent, books: audience.grownUp, total: audience.kids.length ? undefined : recent.total }
      : recent;
  const kidsRow: Shelf | null =
    audience && audience.grownUp.length && audience.kids.length >= MIN_ROW_BOOKS
      ? { id: "new-kids", name: "New for the kids", kind: "continue", books: audience.kids }
      : null;
  const startHere = recentRow?.books.find((b) => !b.percent && !b.kindleOnly) ?? recentRow?.books[0] ?? null;

  if (error) return <BarnabyEmpty title="Barnaby couldn't reach the library">{error}</BarnabyEmpty>;

  const libraryEmpty = shelves != null && !shelves.some((s) => s.books.length);
  const first = inProgress[0];
  const subline = !shelves
    ? " "
    : first
      ? `You're ${Math.round(first.percent * 100)}% through ${first.book.title}.`
      : recent?.total
        ? `${recent.total.toLocaleString()} books on the shelves. What shall we read today?`
        : "What shall we read today?";

  return (
    <div className="bb-page bb-home">
      <Hero name={me?.displayName ?? "there"} subline={subline} askBarnaby={!!ai?.available} />

      <Desk role={role} overview={overview} requests={requests} />

      {!shelves ? (
        <HomeSkeleton />
      ) : libraryEmpty ? (
        <EmptyLibrary admin={role === "admin"} />
      ) : (
        <>
          {inProgress.length ? (
            <JumpBackIn items={inProgress} />
          ) : (
            startHere && <StartSomething book={startHere} />
          )}

          {anchor && similar && similar.length > 0 && (
            <ShelfRow
              shelf={{ id: "similar", name: "", kind: "continue", books: similar }}
              title={`Because you're reading ${anchor.title}`}
            />
          )}

          {recentRow && <ShelfRow shelf={recentRow} />}

          {series.length > 0 && <SeriesSection items={series} />}

          {genreRows?.map((s) => (
            <ShelfRow key={s.id} shelf={s} seeAll={`/categories/${encodeURIComponent(s.id.slice("genre:".length))}`} />
          ))}

          {kidsRow && <ShelfRow shelf={kidsRow} />}

          {extras.map((s) => (
            <ShelfRow key={s.id} shelf={s} />
          ))}

          {categories && categories.length > 0 && (
            <CategorySection items={categories.filter((c) => !genreRows?.some((r) => r.id === `genre:${c.id}`))} />
          )}
        </>
      )}
    </div>
  );
}

function Hero({ name, subline, askBarnaby }: { name: string; subline: string; askBarnaby: boolean }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate(q.trim() ? `/browse?q=${encodeURIComponent(q.trim())}` : "/browse");
  };
  return (
    <section className="bb-home-hero" aria-labelledby="bb-home-hello">
      <div className="bb-home-hello">
        <h1 id="bb-home-hello">
          {greeting(new Date().getHours())}, {name}
        </h1>
        <p className="bb-muted">{subline}</p>
      </div>
      <form className="bb-home-search" role="search" onSubmit={submit}>
        <svg aria-hidden className="bb-home-search-icon" viewBox="0 0 24 24" width="20" height="20">
          <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <path d="m15.5 15.5 5 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search titles, authors, series"
          aria-label="Search the library"
        />
      </form>
      <nav className="bb-home-quick" aria-label="Explore">
        <Link to="/discover">
          <span aria-hidden>✨</span> Discover
        </Link>
        <Link to="/series">
          <span aria-hidden>📚</span> Series
        </Link>
        <Link to="/categories">
          <span aria-hidden>🏷️</span> Categories
        </Link>
        <Link to="/browse">
          <span aria-hidden>🗂️</span> Whole library
        </Link>
        {askBarnaby && (
          <Link to="/barnaby" className="is-barnaby">
            <BarnabyAvatar size={22} /> Ask Barnaby
          </Link>
        )}
      </nav>
    </section>
  );
}

/** Things waiting on this person: the admin's inbox, a parent's approvals, your own requests. */
function Desk({ role, overview, requests }: { role?: string; overview: Overview | null; requests: RequestSummary | null }) {
  const items = deskItems(role, overview, requests);
  if (!items.length) return null;
  return (
    <nav className="bb-home-desk" aria-label="Waiting for you">
      {items.map((i) => (
        <Link key={i.to + i.label} to={i.to} className={i.count ? "has-count" : undefined}>
          <span aria-hidden>{i.icon}</span>
          {i.count != null && <b>{i.count.toLocaleString()}</b>}
          <span>{i.label}</span>
        </Link>
      ))}
    </nav>
  );
}

function JumpBackIn({ items }: { items: InProgress[] }) {
  return (
    <section className="bb-home-section" aria-labelledby="bb-home-jump-h">
      <header className="bb-home-head">
        <h2 id="bb-home-jump-h">
          {items.some((i) => i.listening) ? (items.some((i) => i.reading) ? "Continue reading and listening" : "Continue listening") : "Continue reading"}
        </h2>
      </header>
      <div className={`bb-home-jump${items.length === 1 ? " is-single" : ""}`}>
        {items.map((i) => (
          <JumpCard key={i.book.id} item={i} />
        ))}
      </div>
    </section>
  );
}

function JumpCard({ item }: { item: InProgress }) {
  const { book } = item;
  const author = book.authors?.map((a) => a.name).join(", ");
  const s = book.series?.[0];
  const pct = Math.round(item.percent * 100);
  const readable = item.reading && !book.kindleOnly;
  return (
    <article className="bb-home-jump-card">
      <Link to={`/book/${book.id}`} className="bb-home-jump-cover" tabIndex={-1} aria-hidden>
        <Cover book={book} />
      </Link>
      <div className="bb-home-jump-body">
        <Link to={`/book/${book.id}`} className="bb-home-jump-title">
          {book.title}
        </Link>
        {(author || s) && (
          <span className="bb-home-jump-meta">
            {author}
            {s && `${author ? " · " : ""}${s.name}${s.position != null ? ` #${s.position}` : ""}`}
          </span>
        )}
        <div className="bb-home-jump-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
          <span style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
        </div>
        <span className="bb-home-jump-pct">
          {pct}%{item.listening && item.secondsLeft != null ? ` · ${timeLeft(item.secondsLeft)}` : ""}
        </span>
        <div className="bb-home-jump-actions">
          {readable && (
            <Link className="bb-btn bb-btn-primary" to={`/read/${book.id}`}>
              Continue
            </Link>
          )}
          {item.listening && (
            <Link className={`bb-btn${readable ? "" : " bb-btn-primary"}`} to={`/listen/${book.id}`}>
              <span aria-hidden>🎧</span> {readable ? "Listen" : "Keep listening"}
            </Link>
          )}
          {!readable && !item.listening && (
            <Link className="bb-btn bb-btn-primary" to={`/book/${book.id}`}>
              Open
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

function StartSomething({ book }: { book: BookSummary }) {
  const author = book.authors?.map((a) => a.name).join(", ");
  return (
    <section className="bb-home-section" aria-labelledby="bb-home-start-h">
      <div className="bb-home-start">
        <Link to={`/book/${book.id}`} className="bb-home-jump-cover" tabIndex={-1} aria-hidden>
          <Cover book={book} />
        </Link>
        <div className="bb-home-start-body">
          <h2 id="bb-home-start-h">Nothing on the go yet</h2>
          <p className="bb-muted">
            Here's something new on the shelves: <b className="bb-home-start-title">{book.title}</b>
            {author ? ` by ${author}` : ""}.
          </p>
          <div className="bb-home-jump-actions">
            <Link className="bb-btn bb-btn-primary" to={`/book/${book.id}`}>
              Take a look
            </Link>
            <Link className="bb-btn" to="/discover">
              Find something else
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function SeriesSection({ items }: { items: SeriesPick[] }) {
  return (
    <section className="bb-home-section" aria-labelledby="bb-series-h">
      <header className="bb-home-head">
        <h2 id="bb-series-h">Series to continue</h2>
        <Link className="bb-link" to="/series">
          All series
        </Link>
      </header>
      <div className="bb-home-series-tiles">
        {items.map((s) => (
          <Link key={s.id} to={`/series/${encodeURIComponent(s.id)}`} className="bb-home-series-tile">
            <span className="bb-home-series-stack" aria-hidden>
              {s.books.slice(0, 3).map((b) => (
                <Cover key={b.id} book={b} />
              ))}
            </span>
            <span className="bb-home-series-text">
              <b>{s.name}</b>
              <span className="bb-muted">
                {s.total} {s.total === 1 ? "book" : "books"}
                {s.next ? ` · next: ${s.next.title}` : ""}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function CategorySection({ items }: { items: Category[] }) {
  const shown = items.slice(0, 12);
  return (
    <section className="bb-home-section" aria-labelledby="bb-cats-h">
      <header className="bb-home-head">
        <h2 id="bb-cats-h">Browse by category</h2>
        <Link className="bb-link" to="/categories">
          All categories
        </Link>
      </header>
      <div className="bb-home-cat-tiles">
        {shown.map((c) => (
          <Link key={c.id} to={`/categories/${encodeURIComponent(c.id)}`} className="bb-home-cat-tile">
            <span className="bb-home-cat-text">
              <b>{c.name}</b>
              <span className="bb-muted">
                {c.bookCount.toLocaleString()} {c.bookCount === 1 ? "book" : "books"}
              </span>
            </span>
            <span className="bb-home-cat-covers" aria-hidden>
              {c.books.slice(0, 3).map((b) => (
                <Cover key={b.id} book={b} />
              ))}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function EmptyLibrary({ admin }: { admin: boolean }) {
  return (
    <BarnabyEmpty title="The shelves are empty">
      {admin ? (
        <>
          <p>Add books to your books folder and scan, or move in from Calibre and friends.</p>
          <div className="bb-home-jump-actions bb-center">
            <Link className="bb-btn bb-btn-primary" to="/admin">
              Scan the library
            </Link>
            <Link className="bb-btn" to="/admin/import">
              Import
            </Link>
          </div>
        </>
      ) : (
        <p>Books show up here once a grown-up adds them. You can still ask for one on Requests.</p>
      )}
    </BarnabyEmpty>
  );
}

function HomeSkeleton() {
  return (
    <div className="bb-home-skeleton" aria-busy="true" aria-label="Loading">
      <div className="bb-home-skel bb-home-skel-head" />
      <div className="bb-home-jump">
        <div className="bb-home-skel bb-home-skel-card" />
        <div className="bb-home-skel bb-home-skel-card" />
      </div>
      <div className="bb-home-skel bb-home-skel-head" />
      <div className="bb-home-skel bb-home-skel-row" />
    </div>
  );
}
