import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RATING_LABELS } from "@bookbandit/shared";
import { BarnabyEmpty } from "../brand/Barnaby";
import { requestsApi } from "./api";
import { ago, percent, statusLabel } from "./status";
import type { BookRequest, RequestStatus, Via } from "./types";

const FILTERS: { id: string; label: string; status?: RequestStatus[] }[] = [
  { id: "open", label: "Waiting", status: ["pending"] },
  { id: "active", label: "In progress", status: ["approved", "downloading", "failed"] },
  { id: "all", label: "All" },
];

/** A list of requests: the reader's own, or the ones they can approve. */
export function RequestList({ scope, approvals = false, onChange }: { scope: "mine" | "approvals" | "all"; approvals?: boolean; onChange?: () => void }) {
  const [filter, setFilter] = useState(approvals ? "open" : "all");
  const [items, setItems] = useState<BookRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const f = FILTERS.find((x) => x.id === filter);
    requestsApi.list(scope, f?.status).then((r) => setItems(r.items), (e: Error) => setError(e.message));
  }, [scope, filter]);
  useEffect(load, [load]);

  // Keep download progress fresh while something is moving.
  useEffect(() => {
    if (!items?.some((r) => r.status === "downloading")) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [items, load]);

  const replace = (r: BookRequest) => {
    setItems((all) => all?.map((x) => (x.id === r.id ? r : x)) ?? null);
    onChange?.();
  };
  const remove = (id: string) => {
    setItems((all) => all?.filter((x) => x.id !== id) ?? null);
    onChange?.();
  };

  return (
    <div>
      {approvals && (
        <div className="bb-chips" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} className="bb-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="bb-error">{error}</p>}
      {items && items.length === 0 && (
        <BarnabyEmpty title={approvals ? "Nothing waiting for you" : "No requests yet"} size={140}>
          {approvals ? "When someone asks for a book, it shows up here." : "Ask for a book and it shows up here."}
        </BarnabyEmpty>
      )}
      <ul className="bb-reqs">
        {items?.map((r) => (
          <RequestRow key={r.id} r={r} showWho={approvals} onUpdate={replace} onRemove={remove} />
        ))}
      </ul>
    </div>
  );
}

function RequestRow({ r, showWho, onUpdate, onRemove }: { r: BookRequest; showWho: boolean; onUpdate: (r: BookRequest) => void; onRemove: (id: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [via, setVia] = useState<Via>("auto");
  const [url, setUrl] = useState("");
  const s = statusLabel(r);

  const run = async (fn: () => Promise<BookRequest | void>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (res) onUpdate(res);
      else onRemove(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="bb-req">
      {r.coverUrl ? (
        <img className="bb-cover bb-req-cover" src={r.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <div className="bb-cover bb-cover-blank bb-req-cover" aria-hidden>
          <span>{r.title}</span>
        </div>
      )}
      <div className="bb-req-body">
        <div className="bb-req-head">
          <strong className="bb-req-title">{r.title}</strong>
          <span className={`bb-pill is-${s.tone}`}>
            <span aria-hidden>{s.emoji}</span> {s.text}
            {r.status === "downloading" && percent(r.download?.progress) ? ` ${percent(r.download?.progress)}` : ""}
          </span>
        </div>
        <span className="bb-muted">
          {[r.author, r.publishedYear].filter(Boolean).join(" · ")}
          {showWho && r.requestedBy && (
            <>
              {r.author || r.publishedYear ? " · " : ""}
              asked by {r.requestedBy.avatar ? `${r.requestedBy.avatar} ` : ""}
              <b>{r.requestedBy.displayName}</b>
            </>
          )}{" "}
          · {ago(r.createdAt)}
        </span>
        <span className="bb-small">
          {r.rating ? (
            <span className="bb-rating-tag" title={r.ratingReason ?? undefined}>
              {RATING_LABELS[r.rating]}
            </span>
          ) : (
            showWho && <span className="bb-rating-tag is-unknown">Rating unknown</span>
          )}
          {r.ratingReason && <span className="bb-muted"> from {r.ratingReason}</span>}
        </span>
        {r.note && <p className="bb-req-note">{r.decidedBy && r.status !== "failed" ? `${r.decidedBy.displayName}: ` : ""}{r.note}</p>}
        {r.download?.error && <p className="bb-error bb-small">{r.download.error}</p>}
        {error && <p className="bb-error bb-small">{error}</p>}

        <div className="bb-req-actions">
          {r.book && (
            <Link className="bb-btn bb-btn-primary" to={`/book/${r.book.id}`}>
              Open book
            </Link>
          )}
          {(r.canApprove || r.canDecline) && (
            <input className="bb-input bb-req-noteinput" placeholder="Note (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          )}
          {r.canApprove && (
            <button className="bb-btn bb-btn-primary" disabled={busy} onClick={() => run(() => requestsApi.approve(r.id, note || undefined))}>
              Approve
            </button>
          )}
          {r.canDecline && (
            <button className="bb-btn" disabled={busy} onClick={() => run(() => requestsApi.decline(r.id, note || undefined))}>
              Decline
            </button>
          )}
          {r.canCancel && (
            <button className="bb-btn bb-btn-ghost" disabled={busy} onClick={() => run(async () => requestsApi.withdraw(r.id))}>
              Withdraw
            </button>
          )}
          {r.canDownload && (
            <span className="bb-req-download">
              <select className="bb-input" value={via} onChange={(e) => setVia(e.target.value as Via)} aria-label="Downloader">
                <option value="auto">Any downloader</option>
                <option value="shelfmark">Shelfmark</option>
                <option value="sabnzbd">sabnzbd</option>
                <option value="direct">From a URL</option>
              </select>
              {(via === "direct" || via === "sabnzbd") && (
                <input
                  className="bb-input"
                  type="url"
                  placeholder={via === "direct" ? "https://…/book.epub" : "NZB URL (optional)"}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  aria-label="URL"
                />
              )}
              <button className="bb-btn" disabled={busy || (via === "direct" && !url)} onClick={() => run(() => requestsApi.startDownload(r.id, via, url || undefined))}>
                {r.status === "failed" ? "Try again" : "Download"}
              </button>
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
