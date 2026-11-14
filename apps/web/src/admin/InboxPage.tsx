import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ContentRating } from "@bookbandit/shared";
import { BarnabyEmpty } from "../brand/Barnaby";
import { adminApi, type BarnabyFix, type BarnabyRating, type FixValue, type InboxFilter, type InboxItem, type UnratedBook } from "./api";
import { BookEditor } from "./BookEditor";
import { Card, Cover, ErrorNote, formatBytes, RatingButtons, RatingPill, SHORT_RATING, timeAgo, useAction, useLoad } from "./ui";

const FILTERS: { key: InboxFilter; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "suggested", label: "Barnaby has a suggestion" },
  { key: "unseen", label: "Barnaby hasn't looked yet" },
];

/** Below this, Barnaby's pick is shown as a guess to double-check. */
const SURE = 0.8;

const without = (s: Set<string>, ids: string[]) => {
  const n = new Set(s);
  ids.forEach((id) => n.delete(id));
  return n;
};

/**
 * New books from the scanner wait here until an admin approves them. Barnaby's rating and detail
 * fixes show on each book, so there's one place to review a new book. Books he has rated move on
 * by themselves (Barnaby settings), so what stays is what he hasn't seen and likely copies.
 */
export function InboxPage() {
  const [params] = useSearchParams();
  const asked = params.get("filter");
  const [filter, setFilter] = useState<InboxFilter>(FILTERS.some((f) => f.key === asked) ? (asked as InboxFilter) : "all");
  const inbox = useLoad(() => adminApi.inbox(0, filter), [filter]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulk = useAction();
  const [note, setNote] = useState<string | null>(null);
  const items = inbox.data?.items ?? [];

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const removeMany = (ids: string[]) => {
    inbox.setData((d) => {
      if (!d) return d;
      const gone = d.items.filter((b) => ids.includes(b.id));
      const hadSuggestion = gone.filter((b) => b.barnaby.rating || b.barnaby.fixes.length).length;
      const counts = {
        all: d.counts.all - gone.length,
        suggested: d.counts.suggested - hadSuggestion,
        unseen: d.counts.unseen - (gone.length - hadSuggestion),
      };
      return { ...d, items: d.items.filter((b) => !ids.includes(b.id)), total: d.total - gone.length, counts };
    });
    setSelected((s) => without(s, ids));
  };
  const replace = (b: InboxItem) => inbox.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === b.id ? b : x)) } : d));

  const loadMore = () =>
    bulk.run(async () => {
      const next = await adminApi.inbox(items.length, filter);
      inbox.setData((d) => (d ? { ...next, items: [...d.items, ...next.items.filter((b) => !d.items.some((x) => x.id === b.id))] } : next));
    });

  const chosen = items.filter((b) => selected.has(b.id));
  const withPick = chosen.filter((b) => b.barnaby.rating || b.barnaby.fixes.length);
  const unratedSelected = chosen.some((b) => !b.rating && !b.barnaby.rating);

  const approveSelected = (rating?: ContentRating) =>
    bulk.run(async () => {
      const ids = chosen.map((b) => b.id);
      await adminApi.approve(ids, rating ? { rating } : {});
      removeMany(ids);
    });
  const approveWithBarnaby = () =>
    bulk.run(async () => {
      const ids = withPick.map((b) => b.id);
      await adminApi.approve(ids, { barnabyRating: true, barnabyFixes: true });
      removeMany(ids);
    });
  const askBarnaby = () =>
    bulk.run(async () => {
      const r = await adminApi.askBarnaby(chosen.map((b) => b.id));
      setNote(
        r.rating || r.metadata
          ? `Barnaby is looking at ${Math.min(chosen.length, 500)} books. Ones he rates move to your library by themselves; reload to see what's left.`
          : `Barnaby couldn't start: ${r.error ?? "unknown error"}`,
      );
      setSelected(new Set());
    });

  const allSelected = items.length > 0 && items.every((b) => selected.has(b.id));
  const counts = inbox.data?.counts;

  return (
    <>
      <h1 className="bb-h1">
        Inbox {inbox.data ? <span className="bb-count">{counts?.all ?? inbox.data.total}</span> : null}
      </h1>
      <p className="bb-muted bb-admin-lede">
        New books from your /books folder wait here, hidden from everyone, until they're approved. The rating shown came
        from the book's folder, its genres or its publisher; Barnaby's own pick and any fixes he found sit next to it. Once
        Barnaby has rated a book it moves to your library by itself (adult-only until it has a rating), so what stays here
        is books he hasn't looked at and likely copies of books you have. Change that under{" "}
        <Link to="/barnaby/settings">Barnaby settings</Link>.
      </p>
      <ErrorNote error={inbox.error} />
      {counts && (
        <div className="bb-chips bb-inbox-tabs" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className="bb-chip"
              aria-pressed={filter === f.key}
              onClick={() => {
                setFilter(f.key);
                setSelected(new Set());
              }}
            >
              {f.label} ({counts[f.key]})
            </button>
          ))}
        </div>
      )}
      {inbox.data && items.length === 0 ? (
        <BarnabyEmpty title={filter === "all" ? "Inbox zero!" : "Nothing here"} size={140}>
          {filter === "all" ? "New books show up here after a library scan." : "Try another filter."}
        </BarnabyEmpty>
      ) : (
        <>
          <div className="bb-bulkbar" role="toolbar" aria-label="Selected books">
            <label className="bb-field bb-field-inline">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((b) => b.id)))}
              />
              {selected.size ? `${selected.size} selected` : `Select all ${items.length} shown`}
            </label>
            {selected.size > 0 && (
              <>
                {withPick.length > 0 && (
                  <button
                    className="bb-btn bb-btn-primary"
                    disabled={bulk.busy}
                    onClick={approveWithBarnaby}
                    title="Approve with Barnaby's rating and his detail fixes. Books he hasn't looked at aren't included."
                  >
                    Approve {withPick.length} with Barnaby's picks
                  </button>
                )}
                <button className="bb-btn" disabled={bulk.busy} onClick={() => approveSelected()}>
                  Approve {selected.size} as they are
                  {unratedSelected ? " (unrated stay adult-only)" : ""}
                </button>
                <span className="bb-muted bb-small">or approve as</span>
                <RatingButtons value={null} disabled={bulk.busy} onPick={(r) => approveSelected(r)} label="Approve selected with rating" />
                <button className="bb-btn" disabled={bulk.busy} onClick={askBarnaby} title="Run the rating helper and metadata cleanup on these books now">
                  ✨ Ask Barnaby about {Math.min(selected.size, 500)}
                </button>
              </>
            )}
          </div>
          {note && (
            <p className="bb-muted" role="status">
              {note}
            </p>
          )}
          <ErrorNote error={bulk.error} />
          <ul className="bb-inbox">
            {items.map((b) => (
              <InboxRow key={b.id} book={b} selected={selected.has(b.id)} onToggle={() => toggle(b.id)} onGone={() => removeMany([b.id])} onChange={replace} />
            ))}
          </ul>
          {inbox.data && items.length < inbox.data.total && (
            <div className="bb-inbox-more">
              <button className="bb-btn" disabled={bulk.busy} onClick={loadMore}>
                Show more ({inbox.data.total - items.length} left)
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function InboxRow({
  book,
  selected,
  onToggle,
  onGone,
  onChange,
}: {
  book: InboxItem;
  selected: boolean;
  onToggle: () => void;
  onGone: () => void;
  onChange: (b: InboxItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const action = useAction();
  const pick = book.ratingSource === "admin" ? null : book.barnaby.rating;

  const setRating = (rating: ContentRating) =>
    action.run(async () => {
      await adminApi.setRating(book.id, rating);
      onChange({ ...book, rating, ratingSource: "admin", barnaby: { ...book.barnaby, rating: null } });
    });

  const fixDone = (fix: BarnabyFix, accepted: boolean) => {
    const fixes = book.barnaby.fixes.filter((f) => f.id !== fix.id);
    const patch: Partial<InboxItem> = {};
    if (accepted) {
      if (fix.field === "title" || fix.field === "subtitle" || fix.field === "description") patch[fix.field] = fix.suggested as string;
      if (fix.field === "authors") patch.authors = fix.suggested as string[];
    }
    onChange({ ...book, ...patch, barnaby: { ...book.barnaby, fixes } });
  };

  return (
    <li className={`bb-inbox-row${selected ? " is-selected" : ""}`}>
      <input type="checkbox" className="bb-inbox-check" checked={selected} onChange={onToggle} aria-label={`Select ${book.title}`} />
      <Cover src={adminApi.coverUrl(book)} title={book.title} size={72} />
      <div className="bb-inbox-main">
        <div className="bb-inbox-title">
          <strong>{book.title}</strong>
          {book.subtitle ? <span className="bb-muted"> · {book.subtitle}</span> : null}
        </div>
        <div className="bb-muted bb-small">
          {book.authors.length ? book.authors.join(", ") : <em>No author</em>}
          {book.publishedYear ? ` · ${book.publishedYear}` : ""}
          {book.isbn13 ? ` · ISBN ${book.isbn13}` : ""} · added {timeAgo(book.addedAt)}
        </div>
        <div className="bb-inbox-files bb-small">
          {book.files.map((f) => (
            <span key={f.id} className="bb-file">
              <b>{f.format.toUpperCase()}</b> <code>{f.relPath}</code> {formatBytes(f.sizeBytes)}
            </span>
          ))}
        </div>
        {book.possibleDuplicates.length > 0 && (
          <div className="bb-dupe" role="note">
            Looks like a book you already have:
            {book.possibleDuplicates.map((d) => (
              <button
                key={d.id}
                className="bb-btn bb-btn-small"
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await adminApi.mergeBook(book.id, d.id);
                    onGone();
                  })
                }
                title="Adds this file to the existing book as another format, then removes this inbox entry"
              >
                Merge into “{d.title}”{d.approved ? "" : " (inbox)"}
              </button>
            ))}
          </div>
        )}
        <FixList fixes={book.barnaby.fixes} onDone={fixDone} />
        {editing ? (
          <BookEditor
            book={book}
            onCancel={() => setEditing(false)}
            onSaved={(b) => {
              setEditing(false);
              onChange({ ...book, ...b });
            }}
          />
        ) : null}
        <ErrorNote error={action.error} />
      </div>
      <div className="bb-inbox-side">
        <div className="bb-small">
          Rating: <RatingPill rating={book.rating} source={book.ratingSource} />
        </div>
        {pick && <BarnabyPick pick={pick} />}
        <RatingButtons
          value={book.ratingSource === "admin" ? book.rating : null}
          suggested={pick?.rating ?? null}
          onPick={setRating}
          disabled={action.busy}
        />
        <div className="bb-inbox-actions">
          <button
            className="bb-btn bb-btn-primary"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                await adminApi.approve([book.id], pick ? { barnabyRating: true } : {});
                onGone();
              })
            }
            title={pick ? "Approve with Barnaby's rating" : undefined}
          >
            {pick ? `Approve as ${SHORT_RATING[pick.rating]}` : `Approve${book.rating ? ` as ${SHORT_RATING[book.rating]}` : ""}`}
          </button>
          <button className="bb-btn" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
            Edit details
          </button>
          <button
            className="bb-btn"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                await adminApi.refreshMetadata(book.id);
              })
            }
            title="Look the book up on Hardcover, Google Books and Open Library again"
          >
            Look up online
          </button>
          {confirmReject ? (
            <span className="bb-confirm">
              Move the file to /books/.rejected?
              <button
                className="bb-btn bb-btn-danger"
                disabled={action.busy}
                onClick={() =>
                  action.run(async () => {
                    await adminApi.reject(book.id);
                    onGone();
                  })
                }
              >
                Reject
              </button>
              <button className="bb-btn bb-btn-ghost" onClick={() => setConfirmReject(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button className="bb-btn bb-btn-ghost" onClick={() => setConfirmReject(true)}>
              Reject…
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** Barnaby's suggested rating, how sure he is, and why. */
function BarnabyPick({ pick }: { pick: BarnabyRating }) {
  const sure = pick.confidence >= SURE;
  return (
    <div className={`bb-barnaby-pick${sure ? "" : " is-unsure"}`}>
      ✨ Barnaby suggests <b>{SHORT_RATING[pick.rating]}</b>{" "}
      <span className="bb-muted">
        ({Math.round(pick.confidence * 100)}% sure{sure ? "" : ", worth a look"})
      </span>
      {pick.reasons ? <p>{pick.reasons}</p> : null}
    </div>
  );
}

const FIELD_LABEL: Record<BarnabyFix["field"], string> = {
  title: "Title",
  subtitle: "Subtitle",
  authors: "Authors",
  series: "Series",
  description: "Description",
};

export function fixValueText(v: FixValue): string {
  if (v == null || v === "" || (Array.isArray(v) && !v.length)) return "(none)";
  if (typeof v === "string") return v.length > 220 ? `${v.slice(0, 220)}…` : v;
  if (Array.isArray(v)) return v.join(", ");
  return `${v.name}${v.position != null ? ` #${v.position}` : ""}`;
}

/** Barnaby's pending detail fixes for one book, each with accept and dismiss. */
function FixList({ fixes, onDone }: { fixes: BarnabyFix[]; onDone: (fix: BarnabyFix, accepted: boolean) => void }) {
  const action = useAction();
  if (!fixes.length) return null;
  const accept = (list: BarnabyFix[]) =>
    action.run(async () => {
      for (const fix of list) {
        await adminApi.acceptFix(fix.id);
        onDone(fix, true);
      }
    });
  return (
    <div className="bb-fixes">
      <strong>✨ Barnaby's fixes</strong>
      {fixes.length > 1 && (
        <button className="bb-btn bb-btn-small" style={{ marginLeft: 8 }} disabled={action.busy} onClick={() => accept(fixes)}>
          Accept all {fixes.length}
        </button>
      )}
      <ul>
        {fixes.map((fix) => (
          <li key={fix.id} className="bb-fix">
            <span className="bb-fix-diff">
              <b>{FIELD_LABEL[fix.field]}:</b> <del>{fixValueText(fix.current)}</del> <span aria-hidden>→</span>{" "}
              <ins>{fixValueText(fix.suggested)}</ins>
            </span>
            <button className="bb-btn bb-btn-small bb-btn-primary" disabled={action.busy} onClick={() => accept([fix])}>
              Accept
            </button>
            <button
              className="bb-btn bb-btn-small bb-btn-ghost"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await adminApi.dismissFix(fix.id);
                  onDone(fix, false);
                })
              }
            >
              Dismiss
            </button>
          </li>
        ))}
      </ul>
      {fixes[0]?.reason ? <p className="bb-muted bb-small">{fixes[0].reason}</p> : null}
      <ErrorNote error={action.error} />
    </div>
  );
}

/**
 * "Needs a rating": books in the library nobody has rated (hidden from kids until someone
 * does), plus books where Barnaby has a looser rating waiting for a yes.
 */
export function ReviewPage() {
  const list = useLoad(() => adminApi.unrated());
  const bulk = useAction();
  const items = list.data?.items ?? [];
  const withPick = items.filter((b) => b.barnaby.rating);
  const removeMany = (ids: string[]) =>
    list.setData((d) => (d ? { ...d, items: d.items.filter((x) => !ids.includes(x.id)), total: d.total - ids.length } : d));
  const replace = (b: UnratedBook) => list.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === b.id ? b : x)) } : d));

  return (
    <>
      <h1 className="bb-h1">
        Needs a rating {list.data ? <span className="bb-count">{list.data.total}</span> : null}
      </h1>
      <p className="bb-muted bb-admin-lede">
        These books are in the library but have no rating yet, so only grown-ups can see them, or Barnaby thinks they could
        be shown to younger readers. His pick is outlined with ✨. One tap rates a book and it shows up for every reader old
        enough.
      </p>
      <ErrorNote error={list.error} />
      {list.data && items.length === 0 ? (
        <BarnabyEmpty title="Every book has a rating" size={140} />
      ) : (
        <>
          {withPick.length > 0 && (
            <div className="bb-bulkbar" role="toolbar" aria-label="Barnaby's picks">
              <button
                className="bb-btn bb-btn-primary"
                disabled={bulk.busy}
                onClick={() =>
                  bulk.run(async () => {
                    const ids = withPick.map((b) => b.id);
                    await adminApi.acceptBarnabyRatings(ids);
                    removeMany(ids);
                  })
                }
              >
                Accept Barnaby's picks for {withPick.length} books
              </button>
              <span className="bb-muted bb-small">Each one becomes your rating. Books without a pick stay.</span>
            </div>
          )}
          <ErrorNote error={bulk.error} />
          <Card>
            <ul className="bb-review">
              {items.map((b) => (
                <ReviewRow key={b.id} book={b} onRated={() => removeMany([b.id])} onChange={replace} />
              ))}
            </ul>
          </Card>
          {list.data && items.length < list.data.total && (
            <div className="bb-inbox-more">
              <button
                className="bb-btn"
                disabled={bulk.busy}
                onClick={() =>
                  bulk.run(async () => {
                    const next = await adminApi.unrated(items.length);
                    list.setData((d) => (d ? { ...next, items: [...d.items, ...next.items.filter((b) => !d.items.some((x) => x.id === b.id))] } : next));
                  })
                }
              >
                Show more ({list.data.total - items.length} left)
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function ReviewRow({ book, onRated, onChange }: { book: UnratedBook; onRated: () => void; onChange: (b: UnratedBook) => void }) {
  const action = useAction();
  const pick = book.barnaby.rating;
  return (
    <li className="bb-review-row">
      <Cover src={adminApi.coverUrl(book)} title={book.title} size={48} />
      <div className="bb-review-main">
        <strong>{book.title}</strong>
        <div className="bb-muted bb-small">
          {book.authors.join(", ") || "No author"}
          {book.publishedYear ? ` · ${book.publishedYear}` : ""}
          {book.rating ? (
            <>
              {" "}
              · now <RatingPill rating={book.rating} source={book.ratingSource} />
            </>
          ) : null}
        </div>
        {pick && (
          <div className="bb-small">
            <BarnabyPick pick={pick} />
            <button
              className="bb-btn bb-btn-small bb-btn-ghost"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await adminApi.dismissBarnabyRating(book.id);
                  if (book.rating) onRated();
                  else onChange({ ...book, barnaby: { rating: null } });
                })
              }
            >
              Dismiss his pick
            </button>
          </div>
        )}
        <ErrorNote error={action.error} />
      </div>
      <RatingButtons
        value={null}
        suggested={pick?.rating ?? null}
        disabled={action.busy}
        label={`Rate ${book.title}`}
        onPick={(r) =>
          action.run(async () => {
            await adminApi.setRating(book.id, r);
            onRated();
          })
        }
      />
    </li>
  );
}
