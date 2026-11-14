import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { RATING_LABELS } from "@bookbandit/shared";
import { BarnabySays } from "../brand/Barnaby";
import { requestsApi } from "./api";
import { statusLabel } from "./status";
import type { BookRequest, Candidate, NewRequest } from "./types";

type Outcome = { kind: "asked"; request: BookRequest; duplicate: boolean } | { kind: "owned"; bookId: string } | { kind: "error"; message: string };

/** Search for a book (Open Library, through the server) and request it, or type one in by hand. */
export function AskPanel({ onCreated }: { onCreated?: () => void }) {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [results, setResults] = useState<Candidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [manual, setManual] = useState<NewRequest>({ title: "", author: "", note: "" });
  const [manualOutcome, setManualOutcome] = useState<Outcome | null>(null);

  // Search after a pause, and keep the query in the URL so "Request it" links can prefill it.
  useEffect(() => {
    const query = q.trim();
    const t = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (query) next.set("q", query);
      else next.delete("q");
      setParams(next, { replace: true });
      if (query.length < 2) {
        setResults(null);
        return;
      }
      setSearching(true);
      setError(null);
      requestsApi
        .search(query)
        .then((r) => setResults(r.items), (e: Error) => setError(e.message))
        .finally(() => setSearching(false));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const ask = async (key: string, r: NewRequest): Promise<Outcome> => {
    try {
      const res = await requestsApi.create(r);
      const o: Outcome = res.kind === "owned" ? { kind: "owned", bookId: res.book.id } : { kind: "asked", request: res.request, duplicate: res.duplicate };
      if (o.kind === "asked") onCreated?.();
      if (key) setOutcomes((all) => ({ ...all, [key]: o }));
      return o;
    } catch (e) {
      const o: Outcome = { kind: "error", message: e instanceof Error ? e.message : String(e) };
      if (key) setOutcomes((all) => ({ ...all, [key]: o }));
      return o;
    }
  };

  const submitManual = async (e: FormEvent) => {
    e.preventDefault();
    if (!manual.title?.trim()) return;
    setManualOutcome(await ask("", { title: manual.title.trim(), author: manual.author?.trim() || null, note: manual.note?.trim() || null }));
  };

  return (
    <div className="bb-ask">
      <label className="bb-field bb-ask-search">
        <span className="bb-sr-only">Search for a book</span>
        <input
          className="bb-input"
          type="search"
          placeholder="Title, author or ISBN"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </label>
      {error && <p className="bb-error">{error}</p>}
      {searching && <p className="bb-muted">Searching…</p>}
      {results && !searching && results.length === 0 && <p className="bb-muted">Nothing found. You can type the details below instead.</p>}
      {results && results.length > 0 && (
        <ul className="bb-cands">
          {results.map((c) => (
            <li key={c.ref} className="bb-cand">
              <CandidateCover c={c} />
              <div className="bb-cand-body">
                <strong className="bb-cand-title">{c.title}</strong>
                <span className="bb-muted">
                  {[c.author, c.publishedYear].filter(Boolean).join(" · ")}
                </span>
                {c.rating && (
                  <span className="bb-rating-tag" title={c.ratingReason ?? undefined}>
                    {RATING_LABELS[c.rating]}
                  </span>
                )}
                <CandidateAction c={c} outcome={outcomes[c.ref]} onAsk={() => ask(c.ref, { title: c.title, author: c.author, isbn13: c.isbn13, coverUrl: c.coverUrl?.startsWith("https://") ? c.coverUrl : null, publishedYear: c.publishedYear })} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <details className="bb-manual" open={!!results && results.length === 0}>
        <summary>Can't find it? Type it in</summary>
        <form onSubmit={submitManual} className="bb-manual-form">
          <label className="bb-field">
            <span>Title</span>
            <input className="bb-input" required maxLength={300} value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} />
          </label>
          <label className="bb-field">
            <span>Author</span>
            <input className="bb-input" maxLength={200} value={manual.author ?? ""} onChange={(e) => setManual({ ...manual, author: e.target.value })} />
          </label>
          <label className="bb-field">
            <span>Note for whoever approves it (optional)</span>
            <input className="bb-input" maxLength={500} value={manual.note ?? ""} onChange={(e) => setManual({ ...manual, note: e.target.value })} />
          </label>
          <div>
            <button className="bb-btn bb-btn-primary" type="submit">
              Request it
            </button>
          </div>
          {manualOutcome && <OutcomeNote outcome={manualOutcome} />}
        </form>
      </details>
    </div>
  );
}

function CandidateCover({ c }: { c: Candidate }) {
  return c.coverUrl ? (
    <img className="bb-cover bb-cand-cover" src={c.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
  ) : (
    <div className="bb-cover bb-cover-blank bb-cand-cover" aria-hidden>
      <span>{c.title}</span>
    </div>
  );
}

function CandidateAction({ c, outcome, onAsk }: { c: Candidate; outcome?: Outcome; onAsk: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  if (c.inLibrary) {
    return (
      <Link className="bb-btn" to={`/book/${c.inLibrary.id}`}>
        In your library
      </Link>
    );
  }
  if (outcome) return <OutcomeNote outcome={outcome} />;
  return (
    <button
      className="bb-btn bb-btn-primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await onAsk();
        setBusy(false);
      }}
    >
      {busy ? "Asking…" : "Request it"}
    </button>
  );
}

function OutcomeNote({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === "owned")
    return (
      <p className="bb-outcome is-good">
        Already in the library. <Link to={`/book/${outcome.bookId}`}>Open it</Link>
      </p>
    );
  if (outcome.kind === "error") return <p className="bb-outcome is-bad">{outcome.message}</p>;
  const s = statusLabel(outcome.request);
  return (
    <p className={`bb-outcome is-${s.tone}`}>
      <span aria-hidden>{s.emoji}</span> {outcome.duplicate ? "You already asked for this one: " : "Requested: "}
      {s.text.toLowerCase()}
      {outcome.request.status === "declined" && outcome.request.note ? `. ${outcome.request.note}` : ""}
    </p>
  );
}

export function AskIntro() {
  return <BarnabySays size={56}>Tell me what you'd like to read and I'll go find it.</BarnabySays>;
}
