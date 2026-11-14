import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BarnabySays } from "../brand/Barnaby";
import { requestsApi } from "./api";
import { statusLabel } from "./status";
import type { BookRequest, Candidate } from "./types";

/**
 * Kid mode: "Ask for a book". Big covers, one button, and the wishes they already made.
 * The server only returns books within the kid's limit and a grown-up approves every wish.
 */
export function KidRequests() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [hidden, setHidden] = useState(0);
  const [mine, setMine] = useState<BookRequest[]>([]);
  const [asked, setAsked] = useState<Record<string, BookRequest | { owned: string }>>({});
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(false);

  const loadMine = () => requestsApi.list("mine").then((r) => setMine(r.items), () => setError(true));
  useEffect(() => {
    void loadMine();
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      setSearching(true);
      requestsApi
        .search(query)
        .then((r) => {
          setResults(r.items);
          setHidden(r.hiddenForAge);
        }, () => setError(true))
        .finally(() => setSearching(false));
    }, 500);
    return () => clearTimeout(t);
  }, [q]);

  const ask = async (c: Candidate) => {
    try {
      const res = await requestsApi.create({ title: c.title, author: c.author, isbn13: c.isbn13, coverUrl: c.coverUrl?.startsWith("https://") ? c.coverUrl : null, publishedYear: c.publishedYear });
      setAsked((a) => ({ ...a, [c.ref]: res.kind === "owned" ? { owned: res.book.id } : res.request }));
      void loadMine();
    } catch {
      setError(true);
    }
  };

  return (
    <div className="bb-page bb-kid bb-kid-ask">
      <BarnabySays size={72}>
        <span className="bb-kid-hello">What book do you wish for?</span>
      </BarnabySays>
      <input
        className="bb-input bb-kid-search"
        type="search"
        placeholder="Type a book name"
        aria-label="Book name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {error && <p className="bb-error">Uh oh! Ask a grown-up to help.</p>}
      {searching && <p className="bb-muted">Barnaby is looking…</p>}
      {results && !searching && results.length === 0 && (
        <p className="bb-kid-hint">
          {hidden ? "Those books are for older readers. Try another one!" : "Barnaby couldn't find that one. Try other words!"}
        </p>
      )}
      {results && results.length > 0 && (
        <div className="bb-kid-grid">
          {results.map((c) => {
            const done = asked[c.ref];
            return (
              <div key={c.ref} className="bb-kid-wish">
                {c.coverUrl ? (
                  <img className="bb-cover" src={c.coverUrl} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <div className="bb-cover bb-cover-blank">
                    <span>{c.title}</span>
                  </div>
                )}
                <span className="bb-kid-title">{c.title}</span>
                {c.inLibrary || (done && "owned" in done) ? (
                  <Link className="bb-btn bb-btn-big" to={`/read/${c.inLibrary?.id ?? (done as { owned: string }).owned}`}>
                    <span aria-hidden>📖</span> Read it!
                  </Link>
                ) : done && "status" in done ? (
                  <span className={`bb-pill is-${statusLabel(done, true).tone}`}>
                    <span aria-hidden>{statusLabel(done, true).emoji}</span> {statusLabel(done, true).text}
                  </span>
                ) : (
                  <button className="bb-btn bb-btn-primary bb-btn-big" onClick={() => ask(c)}>
                    <span aria-hidden>⭐</span> I want this!
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <h2 className="bb-kid-h2">
        <span aria-hidden>🌟</span> My wishes
      </h2>
      {mine.length === 0 ? (
        <p className="bb-kid-hint">No wishes yet. Search for a book above!</p>
      ) : (
        <ul className="bb-kid-wishes">
          {mine.map((r) => {
            const s = statusLabel(r, true);
            return (
              <li key={r.id} className={`bb-kid-wishrow is-${s.tone}`}>
                <span className="bb-kid-wish-emoji" aria-hidden>
                  {s.emoji}
                </span>
                <span className="bb-kid-wish-title">{r.title}</span>
                {r.book ? (
                  <Link className="bb-btn bb-btn-primary" to={`/read/${r.book.id}`}>
                    Read it!
                  </Link>
                ) : (
                  <span className="bb-kid-wish-status">{s.text}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
